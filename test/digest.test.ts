import { describe, expect, it } from 'vitest';
import { digestDto } from '../src/core/api/contract';
import { ROUTE_SCOPES } from '../src/core/identity/scopes';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, openChat, rows, seedPlan, workspace } from './helpers/workspace';

// T13: a weekly usage digest for the merchant, in the app (not a WhatsApp template: ruling GROWTH-DIGEST-1), counts only, and the owner can switch it off.
useApiKey();
const DAY = 86_400_000;
const NOW = Date.now();

async function seedWeek(ws: string) {
  await seedPlan(ws);
  const conv = await openChat(ws, '201001234567', { text: 'مرحبا', wamid: `wamid.dg.${ws.slice(-4)}.1`, ts: Math.floor((NOW - 2 * DAY) / 1000) });
  await openChat(ws, '201112223333', { text: 'سعر؟', wamid: `wamid.dg.${ws.slice(-4)}.2`, ts: Math.floor((NOW - 1 * DAY) / 1000) });
  await openChat(ws, '201009998877', { text: 'old', wamid: `wamid.dg.${ws.slice(-4)}.old`, ts: Math.floor((NOW - 20 * DAY) / 1000) }); // outside the week
  for (const [i, st] of ['delivered', 'sent', 'failed'].entries()) {
    await exec(ws, "INSERT INTO messages (wamid, conversation_id, direction, type, preview, status, author, created_at, updated_at) VALUES (?, ?, 'out', 'text', 'x', ?, ?, ?, 0)", `out.${ws.slice(-4)}.${i}`, conv, st, i === 0 ? 'agent' : null, NOW - DAY);
  }
  await exec(ws, "INSERT INTO credit_ledger (at, kind, amount, balance_after, ref) VALUES (?, 'grant', 100, 100, 'g1'), (?, 'ai_charge', -1, 99, 'ai:1'), (?, 'ai_charge', -1, 98, 'ai:2')", NOW - 5 * DAY, NOW - 2 * DAY, NOW - DAY);
  await exec(ws, "INSERT INTO wallet_ledger (at, kind, net_minor, amount_minor, balance_after, ref) VALUES (?, 'topup', 10000, 10000, 10000, 't1'), (?, 'meta_charge', -300, -300, 9700, 'm1'), (?, 'meta_charge', -250, -250, 9450, 'm2')", NOW - 6 * DAY, NOW - 3 * DAY, NOW - 2 * DAY);
}

describe('GET /digest', () => {
  it('counts the last 7 days: customers who wrote, messages in and out, failures, AI replies and credits used, Meta spend, balance', async () => {
    const ws = W(9700);
    const api = await apiFor(ws);
    await seedWeek(ws);
    const d = digestDto.parse(await (await api.call('GET', '/digest')).json());
    expect(d.enabled).toBe(true);
    if (!d.enabled) return;
    expect(d.to - d.from).toBe(7 * DAY);
    expect(d).toMatchObject({
      customersWrote: 2, messagesIn: 2, messagesOut: 3, delivered: 1, failed: 1, aiReplies: 2, aiCreditsUsed: 2, spendMinor: 550, topupsMinor: 10000,
    });
    expect(d.balanceMinor).toBe(9450);
    expect(d.aiCredits).toMatchObject({ available: 98 });
  });

  it('contains counts and amounts only: no phone number, no name, no message text', async () => {
    const ws = W(9701);
    const api = await apiFor(ws);
    await seedWeek(ws);
    const body = await (await api.call('GET', '/digest')).json();
    const strings: string[] = [];
    const walk = (v: unknown): void => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(body);
    expect(strings).toEqual([]); // every value is a number or a boolean: nothing a person wrote, nothing that names a person
  });

  it('an empty week is zeros, not an error', async () => {
    const ws = W(9702);
    const api = await apiFor(ws);
    const d = digestDto.parse(await (await api.call('GET', '/digest')).json());
    expect(d).toMatchObject({ enabled: true, messagesIn: 0, messagesOut: 0, spendMinor: 0 });
  });
});

describe('opting out', () => {
  it('the owner switches it off and back on; while off, the digest returns {enabled:false} and no figures', async () => {
    const ws = W(9703);
    const owner = await apiFor(ws, 'owner');
    await seedWeek(ws);
    expect((await owner.call('PUT', '/digest', { enabled: false })).status).toBe(200);
    expect(await (await owner.call('GET', '/digest')).json()).toEqual({ enabled: false });
    expect((await owner.call('PUT', '/digest', { enabled: true })).status).toBe(200);
    expect(((await (await owner.call('GET', '/digest')).json()) as { enabled: boolean }).enabled).toBe(true);
  });
  it('staff may read it but not change the setting; a malformed body is 400', async () => {
    const ws = W(9704);
    const owner = await apiFor(ws, 'owner');
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('GET', '/digest')).status).toBe(200);
    expect((await staff.call('PUT', '/digest', { enabled: false })).status).toBe(403);
    expect((await owner.call('PUT', '/digest', { enabled: 'no' })).status).toBe(400);
    expect(((await (await owner.call('GET', '/digest')).json()) as { enabled: boolean }).enabled).toBe(true);
  });
  it('the setting is stored per workspace (a marker row), not shared', async () => {
    const a = W(9705);
    const b = W(9706);
    const oa = await apiFor(a, 'owner');
    const ob = await apiFor(b, 'owner');
    await oa.call('PUT', '/digest', { enabled: false });
    expect(((await (await ob.call('GET', '/digest')).json()) as { enabled: boolean }).enabled).toBe(true);
    expect(await rows(a, "SELECT value FROM store_state WHERE key = 'digest.enabled'")).toEqual([{ value: '0' }]);
  });
});

describe('integrator tokens', () => {
  it('both routes have a scope decision: reading needs a scope the digest does not need (person only), writing is person-only', () => {
    expect(ROUTE_SCOPES['GET /stores/:storeId/digest']).toBe('person_only');
    expect(ROUTE_SCOPES['PUT /stores/:storeId/digest']).toBe('person_only');
  });
});

describe('the digest uses the workspace\'s own clock argument', () => {
  it('a digest asked for a later time covers the 7 days before THAT time', async () => {
    const ws = W(9707);
    await seedWeek(ws);
    const later = await workspace(ws).weeklyDigest(NOW + 10 * DAY);
    expect(later).toMatchObject({ enabled: true, messagesIn: 0 });
  });
});
