// Self-service A28/A31-A33 (theme bot-settings): the owner flips the ordering bot, order confirmation messages and store-login codes over WhatsApp.
// Turning ON something that messages customers or costs money needs a server-issued, single-use confirm token bound to the exact payload.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { workspace } from './helpers/workspace';

useApiKey();
type Audit = { actor: string; actor_role: string; action: string; target_type: string | null; target_id: string | null; detail: string | null; status: number };
const toggles = async (ws: string) => (await env.DB.prepare("SELECT * FROM audit_log WHERE workspace_id = ? AND action = 'store_link.toggle' ORDER BY id").bind(ws).all<Audit>()).results;
const settings = async (api: Awaited<ReturnType<typeof apiFor>>) => (await (await api.call('GET', '/store-link/settings')).json()) as Record<string, unknown>;
const preview = (api: Awaited<ReturnType<typeof apiFor>>, body: unknown) => api.call('POST', '/store-link/settings/preview', body);
const issue = async (api: Awaited<ReturnType<typeof apiFor>>, body: unknown) => ((await (await preview(api, body)).json()) as { confirmToken: string }).confirmToken;

describe('ordering bot switch (A31, preview policy: no token)', () => {
  it('persists, shows in GET, writes a named audit row, and keeps staff out', async () => {
    const ws = W(8101);
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await owner.call('PATCH', '/store-link/settings', { orderingBot: false })).status).toBe(200);
    expect((await settings(owner)).orderingBot).toBe(false);
    expect((await staff.call('PATCH', '/store-link/settings', { orderingBot: true })).status).toBe(403);
    expect((await settings(owner)).orderingBot).toBe(false);
    const rows = await toggles(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_role: 'owner', target_type: 'setting', target_id: 'orderingBot', status: 200 });
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ value: false, changed: true });
  });
});

describe('order confirmation messages (A32) and store-login codes (A33): confirm before ON', () => {
  it('refuses ON without a token, accepts it with one from preview, and writes the audit row', async () => {
    const ws = W(8102);
    const owner = await apiFor(ws);
    const bare = await owner.call('PATCH', '/store-link/settings', { orderConfirmations: true });
    expect(bare.status).toBe(409);
    expect(await bare.json()).toMatchObject({ message: 'confirm_required' });
    const token = await issue(owner, { orderConfirmations: true });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const ok = await owner.call('PATCH', '/store-link/settings', { orderConfirmations: true, confirmToken: token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ orderConfirmations: true });
    const rows = await toggles(ws);
    expect(rows.map((r) => r.target_id)).toEqual(['orderConfirmations']);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ value: true, confirmed: true });
  });

  it('turning OFF needs no token (the safe direction) and is audited', async () => {
    const ws = W(8103);
    const owner = await apiFor(ws);
    expect((await owner.call('PATCH', '/store-link/settings', { orderConfirmations: false, otpViaWhatsApp: false })).status).toBe(200);
    expect((await toggles(ws)).map((r) => r.target_id)).toEqual(['orderConfirmations', 'otpViaWhatsApp']);
  });

  it('a token works once: replaying it is refused and changes nothing', async () => {
    const ws = W(8104);
    const owner = await apiFor(ws);
    const token = await issue(owner, { otpViaWhatsApp: true });
    expect((await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: true, confirmToken: token })).status).toBe(200);
    expect((await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: false })).status).toBe(200);
    const replay = await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: true, confirmToken: token });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ message: 'confirm_invalid' });
    expect((await settings(owner)).otpViaWhatsApp).toBe(false);
  });

  it('an edited payload is refused: a token for one change cannot enable another', async () => {
    const ws = W(8105);
    const owner = await apiFor(ws);
    await owner.call('PATCH', '/store-link/settings', { orderConfirmations: false });
    const token = await issue(owner, { otpViaWhatsApp: true });
    const edited = await owner.call('PATCH', '/store-link/settings', { orderConfirmations: true, confirmToken: token });
    expect(edited.status).toBe(409);
    expect(await edited.json()).toMatchObject({ message: 'confirm_invalid' });
    expect((await settings(owner)).orderConfirmations).toBe(false);
    // the refused try burned the token
    expect((await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: true, confirmToken: token })).status).toBe(409);
  });

  it('an unknown or malformed token is refused', async () => {
    const owner = await apiFor(W(8106));
    expect((await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: true, confirmToken: 'a'.repeat(64) })).status).toBe(409);
    expect((await owner.call('PATCH', '/store-link/settings', { otpViaWhatsApp: true, confirmToken: 'nope' })).status).toBe(400);
  });

  it('is bound to the person and to the clock (checked at the workspace)', async () => {
    const ws = W(8107);
    await apiFor(ws);
    const stub = workspace(ws);
    const a = await stub.issueSettingsConfirm('user-a', 'hash-1', 1_000);
    expect(await stub.consumeSettingsConfirm(a.token, 'user-b', 'hash-1', 2_000)).toBe('mismatch');
    const b = await stub.issueSettingsConfirm('user-a', 'hash-1', 1_000);
    expect(await stub.consumeSettingsConfirm(b.token, 'user-a', 'hash-1', b.expiresAt + 1)).toBe('expired');
    const c = await stub.issueSettingsConfirm('user-a', 'hash-1', 1_000);
    expect(await stub.consumeSettingsConfirm(c.token, 'user-a', 'hash-1', 2_000)).toBe('ok');
    expect(await stub.consumeSettingsConfirm(c.token, 'user-a', 'hash-1', 2_000)).toBe('invalid');
  });

  it('keeps only a few pending tokens per workspace', async () => {
    const ws = W(8108);
    await apiFor(ws);
    const stub = workspace(ws);
    const first = await stub.issueSettingsConfirm('u', 'h', 1_000);
    for (let i = 0; i < 25; i++) await stub.issueSettingsConfirm('u', 'h', 1_001 + i);
    expect(await stub.consumeSettingsConfirm(first.token, 'u', 'h', 2_000)).toBe('invalid');
  });

  it('preview is owner-only, validates the body, and refuses a change that needs no confirm', async () => {
    const ws = W(8109);
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    expect((await preview(staff, { orderConfirmations: true })).status).toBe(403);
    expect((await preview(owner, {})).status).toBe(400);
    expect((await preview(owner, { orderConfirmations: 'yes' })).status).toBe(400);
    expect((await preview(owner, { orderingBot: false })).status).toBe(400);
    expect((await preview(owner, { orderConfirmations: false })).status).toBe(400);
    expect((await preview(owner, { orderConfirmations: true })).status).toBe(200);
  });
});

describe('throughput and tier usage (A28)', () => {
  it('the owner and staff both read the tier, speed, use and queue', async () => {
    const ws = W(8110);
    const owner = await apiFor(ws);
    const staff = await apiFor(ws, 'staff');
    for (const who of [owner, staff]) {
      const res = await who.call('GET', '/throttle');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ tier: 250, mps: 80, usedInWindow: 0, waiting: 0, nextSlotAt: null });
    }
  });
});
