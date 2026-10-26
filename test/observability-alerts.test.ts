import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alert, bindAlerts, resetAlerts } from '../src/core/observability';
import worker, { WorkspaceDO } from '../src/index';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { exec, openChat, own, rows, workspace } from './helpers/workspace';

useApiKey();
const SECRETS = { TELEGRAM_BOT_TOKEN: '123456:AAF-test-token', TELEGRAM_ALERT_CHAT_ID: '-1001234567', ALERT_PRODUCT: 'Ebda WhatsApp' };
const PHONE = '201001234567';

type Harness = { telegram: { url: string; body: Record<string, string> }[]; messages: { message: string; level: string }[]; exceptions: unknown[]; waits: Promise<unknown>[]; flush(): Promise<void> };
function harness(e: Record<string, string> = SECRETS, over: { fetchFails?: boolean; captureThrows?: boolean } = {}): Harness {
  const h: Harness = { telegram: [], messages: [], exceptions: [], waits: [], flush: async () => { await Promise.allSettled(h.waits); } };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch ${url}`);
    if (over.fetchFails) throw new Error('telegram down');
    h.telegram.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response('{"ok":true}');
  });
  bindAlerts({
    env: e, waitUntil: (p) => { h.waits.push(p); },
    captureMessage: (message, level) => { if (over.captureThrows) throw new Error('sentry down'); h.messages.push({ message, level }); },
    captureException: (err) => { h.exceptions.push(err); },
  });
  return h;
}
beforeEach(() => resetAlerts());
afterEach(() => { resetAlerts(); vi.restoreAllMocks(); });

describe('alert(): P0 / P1 reach a human, info stays in the logs', () => {
  it('P1: a Sentry EVENT (captureMessage, level warning) and one Telegram sendMessage with name, severity, workspace and the runbook; the JSON log line is kept', async () => {
    const h = harness();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    alert('entitlement_push_failed', { severity: 'P1', workspace: '0a1b2c3d-1111-4222-8333-444455556666', error: 'DOException' });
    await h.flush();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ level: 'warning' });
    expect(h.messages[0]!.message).toContain('entitlement_push_failed');
    expect(h.telegram).toHaveLength(1);
    expect(h.telegram[0]!.url).toBe(`https://api.telegram.org/bot${SECRETS.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(h.telegram[0]!.body.chat_id).toBe(SECRETS.TELEGRAM_ALERT_CHAT_ID);
    const text = h.telegram[0]!.body.text!;
    expect(text).toContain('Ebda WhatsApp');
    expect(text).toContain('entitlement_push_failed');
    expect(text).toContain('P1');
    expect(text).toContain('0a1b2c3d'); // the workspace, shortened
    expect(text).toContain('docs/runbooks/alerts.md');
    expect(log).toHaveBeenCalledWith(JSON.stringify({ alert: 'entitlement_push_failed', severity: 'P1', workspace: '0a1b2c3d-1111-4222-8333-444455556666', error: 'DOException' }));
  });
  it('P0 is a Sentry error event; a known money alert is P1/P0 without the caller saying so; info (and an unknown name) is console only', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    alert('ledger_mirror_mismatch', { workspace: 'ws-a' });
    alert('wallet_low_balance', { workspace: 'ws-a' });
    alert('some_new_unclassified_thing', {});
    await h.flush();
    expect(h.messages.map((m) => m.level)).toEqual(['error']);
    expect(h.telegram).toHaveLength(1);
    expect(h.telegram[0]!.body.text).toContain('P0');
  });
  it('with the Telegram secrets unset it logs and records the Sentry event only, and does not call the network', async () => {
    const h = harness({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    alert('send_dlq', { severity: 'P1', workspace: 'ws-a' });
    await h.flush();
    expect(h.messages).toHaveLength(1);
    expect(h.telegram).toEqual([]);
  });
  it('is throttled per (name, workspace) for 10 minutes, per name and per workspace independently, and says how many it suppressed', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    for (let i = 0; i < 5; i++) alert('send_dlq', { severity: 'P1', workspace: 'ws-a' });
    alert('send_dlq', { severity: 'P1', workspace: 'ws-b' });
    alert('other_failure', { severity: 'P1', workspace: 'ws-a' });
    await h.flush();
    expect(h.telegram).toHaveLength(3);
    t += 9 * 60_000;
    alert('send_dlq', { severity: 'P1', workspace: 'ws-a' });
    await h.flush();
    expect(h.telegram).toHaveLength(3);
    t += 2 * 60_000;
    alert('send_dlq', { severity: 'P1', workspace: 'ws-a' });
    await h.flush();
    expect(h.telegram).toHaveLength(4);
    expect(h.telegram[3]!.body.text).toContain('suppressed 5');
    // the JSON line is never throttled
  });
  it('never throws into the caller: Telegram down, Sentry throwing, no binding at all', async () => {
    const h = harness(SECRETS, { fetchFails: true, captureThrows: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => alert('send_dlq', { severity: 'P0', workspace: 'ws-a' })).not.toThrow();
    await h.flush();
    resetAlerts(); // nothing bound
    expect(() => alert('send_dlq', { severity: 'P0', workspace: 'ws-a' })).not.toThrow();
  });
  it('is fire-and-forget: the send is handed to waitUntil and alert() returns before it settles', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    alert('send_dlq', { severity: 'P1', workspace: 'ws-a' });
    expect(alert('send_dlq', { severity: 'P1', workspace: 'ws-b' })).toBeUndefined(); // nothing to await
    expect(h.waits.length).toBeGreaterThan(0); // the runtime is told to keep the send alive
    await h.flush();
    expect(h.telegram).toHaveLength(2);
  });
  it('NEVER puts a phone number, a message body or a secret in Telegram or Sentry', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    alert('send_dlq', {
      severity: 'P0', workspace: 'ws-a', error: `failed for +${PHONE} and 0100 123 4567`, to: PHONE, waId: PHONE, body: 'my secret message', text: 'hello customer', token: 'tok-SECRET-1', customer: `٠١٠٠١٢٣٤٥٦٧`,
    });
    await h.flush();
    const everything = JSON.stringify([h.telegram.map((t) => t.body.text), h.messages]); // (the chat id in the request body is a long number by nature)
    expect(everything).not.toMatch(/\d{8,}/);
    expect(everything).not.toContain('01001234567');
    for (const bad of ['my secret message', 'hello customer', 'tok-SECRET-1', '٠١٠٠١٢٣٤٥٦٧']) expect(everything, bad).not.toContain(bad);
    expect(everything).toContain('send_dlq');
  });
});

describe('app.onError and the Durable Object', () => {
  it('a route that throws answers 500 {error:"internal"} and the error is captured with its text masked', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...env, ...SECRETS, get COMMIT_SHA(): string { throw new Error(`boom for ${PHONE}`); } } as unknown as typeof env;
    const res = await worker.fetch(new Request('https://x/health'), broken, createExecutionContext());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal' });
    await h.flush();
    expect(h.exceptions.length).toBeGreaterThan(0);
    expect(h.telegram.length).toBeGreaterThan(0); // a 5xx is a P1 `unhandled_error`
    expect(JSON.stringify([h.telegram.map((t) => t.body.text), h.messages])).not.toContain(PHONE);
  });
  it('the WorkspaceDO class is instrumented but still the DO the bindings use', async () => {
    expect(typeof WorkspaceDO).toBe('function');
    const ws = W(1100);
    await apiFor(ws);
    expect(await workspace(ws).getEntitlement()).not.toBeUndefined();
  });
});

describe('the send DLQ has a consumer', () => {
  it('marks an unsent message failed (send_dlq) and raises a P1; an invalid body is acknowledged; the batch is acked', async () => {
    const h = harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = W(1101);
    await apiFor(ws);
    await own(ws);
    const conv = await openChat(ws);
    const key = `ui:${crypto.randomUUID()}`;
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'text', clientId: key.slice(3), text: 'hello' })).toMatchObject({ ok: true });
    const job = { workspaceId: ws, phoneNumberId: 'pn-x', to: PHONE, idempotencyKey: key, kind: 'text', text: 'hello' };
    const batch = createMessageBatch('ebda-wa-send-dlq', [{ id: 'a', timestamp: new Date(), attempts: 5, body: job }, { id: 'b', timestamp: new Date(), attempts: 5, body: { nonsense: true } as unknown }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(['a', 'b']);
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', key)).toEqual([{ status: 'failed', error_reason: 'send_dlq' }]);
    await h.flush();
    expect(h.messages.some((m) => m.message.includes('send_dlq'))).toBe(true);
    expect(JSON.stringify([h.telegram.map((t) => t.body.text), h.messages])).not.toContain(PHONE);
  });
  it('a message already sent is left alone', async () => {
    harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ws = W(1102);
    await apiFor(ws);
    await own(ws);
    const conv = await openChat(ws);
    const id = crypto.randomUUID();
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'text', clientId: id, text: 'hello' })).toMatchObject({ ok: true });
    await exec(ws, "UPDATE messages SET status = 'accepted' WHERE idempotency_key = ?", `ui:${id}`);
    const batch = createMessageBatch('ebda-wa-send-dlq', [{ id: 'a', timestamp: new Date(), attempts: 5, body: { workspaceId: ws, phoneNumberId: 'pn-x', to: PHONE, idempotencyKey: `ui:${id}`, kind: 'text', text: 'hello' } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    await getQueueResult(batch, ctx);
    expect(await rows(ws, 'SELECT status FROM messages WHERE idempotency_key = ?', `ui:${id}`)).toEqual([{ status: 'accepted' }]);
  });

  // Billing integrity: a `claimed` row may be in flight to Meta (sent, recorded later). Failing it would mark a delivered message failed and release
  // the hold of a paid send, so the DLQ only touches rows that provably never left (queued / retry).
  describe.each([
    ['queued', true, 'failed', 'released'],
    ['retry', true, 'failed', 'released'],
    ['claimed', false, 'claimed', 'held'],
  ] as const)('a dead letter for a %s row', (state, changes, status, hold) => {
    it(changes ? 'fails it and settles its wallet hold' : 'changes nothing (status, hold) and tells a human the state', async () => {
      const h = harness();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const ws = W(state === 'queued' ? 1110 : state === 'retry' ? 1111 : 1112);
      await apiFor(ws);
      await own(ws);
      const conv = await openChat(ws);
      const id = crypto.randomUUID();
      const key = `ui:${id}`;
      expect(await workspace(ws).queueOutbound(conv, 'pn-x', { type: 'text', clientId: id, text: 'hello' })).toMatchObject({ ok: true });
      await exec(ws, 'UPDATE messages SET status = ? WHERE idempotency_key = ?', state, key);
      await exec(ws, "INSERT OR REPLACE INTO wallet_holds (ref, amount_minor, state, expires_at, created_at, funding) VALUES (?, 500, 'held', ?, ?, 'platform_line')", `msg:${key}`, Date.now() + 86_400_000, Date.now());
      const batch = createMessageBatch('ebda-wa-send-dlq', [{ id: 'a', timestamp: new Date(), attempts: 5, body: { workspaceId: ws, phoneNumberId: 'pn-x', to: PHONE, idempotencyKey: key, kind: 'text', text: 'hello' } }]);
      const ctx = createExecutionContext();
      await worker.queue(batch, env, ctx);
      expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['a']);
      expect(await rows(ws, 'SELECT status FROM messages WHERE idempotency_key = ?', key)).toEqual([{ status }]);
      expect(await rows(ws, 'SELECT state FROM wallet_holds WHERE ref = ?', `msg:${key}`)).toEqual([{ state: hold }]);
      await h.flush();
      expect(log.mock.calls.flat().join(' ')).toContain(`"state":"${state === 'claimed' ? 'claimed' : 'failed'}"`);
      expect(h.messages.some((m) => m.message.includes('send_dlq'))).toBe(true); // a human is told either way
    });
  });
});
