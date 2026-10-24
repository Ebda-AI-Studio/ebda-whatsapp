import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { WhatsAppOtp } from '../src/index';
import { stubGraph, type GraphReply } from './helpers/graph';
import { storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000048${String(n).padStart(2, '0')}`;
const CODE = 'K7Q93X';
const otp = () => new WhatsAppOtp(createExecutionContext(), env);
const on = (ws: string) => workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: true });
const posts = (g: ReturnType<typeof stubGraph>) => g.calls.filter((c) => c.method === 'POST');

describe('WhatsApp one-time codes (OTP-1)', () => {
  it('is off by default: nothing is sent and nothing is stored', async () => {
    const ws = W(1);
    await storeWorkspace(ws);
    const g = stubGraph();
    expect(await otp().sendOtp(ws, '01001234567', CODE)).toEqual({ ok: false, reason: 'disabled' });
    expect(g.calls).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM messages')).toEqual([]);
  });

  it('sends the authentication template to the normalised number when the store turns it on', async () => {
    const ws = W(2);
    await storeWorkspace(ws);
    await on(ws);
    const g = stubGraph();
    expect(await otp().sendOtp(ws, '٠١٠٠١٢٣٤٥٦٧', CODE)).toEqual({ ok: true });
    expect(posts(g)).toHaveLength(1);
    expect(posts(g)[0]!.body).toMatchObject({
      to: '201001234567', type: 'template',
      template: { name: 'otp_code', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: CODE }] }, { type: 'button', sub_type: 'url', parameters: [{ type: 'text', text: CODE }] }] },
    });
    expect(await rows(ws, "SELECT status, type FROM messages WHERE direction = 'out'")).toEqual([{ status: 'accepted', type: 'template' }]);
  });

  it('the code exists only in the Graph request: masked in every table, event and task of the workspace', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    await on(ws);
    stubGraph();
    await otp().sendOtp(ws, '+201001234567', CODE);
    const tables = (await rows<{ name: string }>(ws, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%'")).map((t) => t.name);
    for (const t of tables) expect(JSON.stringify(await rows(ws, `SELECT * FROM ${t}`)), t).not.toContain(CODE);
    expect(await rows(ws, "SELECT preview, body FROM messages WHERE direction = 'out'")).toEqual([{ preview: '••••••', body: '••••••' }]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toEqual([]);
    expect(await workspace(ws).search(CODE, 10)).toEqual([]);
  });

  it('never logs the code or the phone number', async () => {
    const ws = W(4);
    await storeWorkspace(ws);
    await on(ws);
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    stubGraph((): GraphReply => ({ status: 400, json: { error: { code: 131026, message: 'undeliverable' } } }));
    await otp().sendOtp(ws, '+201001234567', CODE);
    await otp().sendOtp(ws, 'garbage', CODE);
    await otp().sendOtp('missing-store', '+201001234567', CODE);
    const out = logs.flatMap((l) => l.mock.calls).map((c) => JSON.stringify(c)).join('\n');
    expect(out).not.toContain(CODE);
    expect(out).not.toContain('1001234567');
  });

  it('refuses bad input, an unknown store, a store with no number or no approved template', async () => {
    const ws = W(5);
    await storeWorkspace(ws);
    await on(ws);
    const g = stubGraph();
    for (const [phone, code] of [['abc', CODE], ['+201001234567', 'has space'], ['+201001234567', 'x'.repeat(16)], ['+201001234567', '']] as const) {
      expect(await otp().sendOtp(ws, phone, code), `${phone}/${code}`).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await otp().sendOtp(W(99), '+201001234567', CODE)).toEqual({ ok: false, reason: 'not_found' });
    await exec(ws, "UPDATE templates SET status = 'PENDING' WHERE name = 'otp_code'");
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toEqual({ ok: false, reason: 'template_unavailable' });
    await env.DB.prepare("UPDATE phone_numbers SET status = 'disconnected' WHERE workspace_id = ?").bind(ws).run();
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toEqual({ ok: false, reason: 'no_number' });
    expect(posts(g)).toEqual([]);
  });

  it('allows five codes per phone per ten minutes, then answers rate_limited', async () => {
    const ws = W(6);
    await storeWorkspace(ws);
    await on(ws);
    const g = stubGraph();
    for (let i = 0; i < 5; i++) expect(await otp().sendOtp(ws, '+201001234567', `C${i}`)).toEqual({ ok: true });
    expect(await otp().sendOtp(ws, '+201001234567', 'C9')).toEqual({ ok: false, reason: 'rate_limited' });
    expect(await otp().sendOtp(ws, '+201112223334', 'C9')).toEqual({ ok: true }); // another phone is unaffected
    expect(posts(g)).toHaveLength(6);
  });

  it('reports a permanent Meta refusal as send_failed and leaves a failed (masked) message', async () => {
    const ws = W(7);
    await storeWorkspace(ws);
    await on(ws);
    stubGraph((): GraphReply => ({ status: 400, json: { error: { code: 131026, message: 'undeliverable' } } }));
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toEqual({ ok: false, reason: 'send_failed' });
    expect(await rows(ws, "SELECT status, error_code FROM messages WHERE direction = 'out'")).toEqual([{ status: 'failed', error_code: 131026 }]);
  });

  it('a retryable Meta failure is handed to the send queue (and the code is not left in the scheduler)', async () => {
    const ws = W(8);
    await storeWorkspace(ws);
    await on(ws);
    stubGraph((): GraphReply => ({ status: 500, json: { error: { code: 2, message: 'busy' } } }));
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toEqual({ ok: true });
    expect(vi.mocked(env.SEND_QUEUE.sendBatch)).toHaveBeenCalledTimes(1);
  });

  it('the setting is the switch: owner turns it on and off through the settings route', async () => {
    const ws = W(9);
    await storeWorkspace(ws);
    stubGraph();
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toMatchObject({ reason: 'disabled' });
    await on(ws);
    expect(await otp().sendOtp(ws, '+201001234567', CODE)).toEqual({ ok: true });
    await workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: false });
    expect(await otp().sendOtp(ws, '+201001234567', 'ZZ1')).toMatchObject({ reason: 'disabled' });
  });
});
