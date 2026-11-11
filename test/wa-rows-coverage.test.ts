import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_LIMITS, configureApiLimits, takeApiToken } from '../src/core/api-rate';
import { digestCounts } from '../src/core/digest';
import { Buckets } from '../src/core/request-guards';
import { exec, openChat, rows, workspace } from './helpers/workspace';

afterEach(() => vi.restoreAllMocks());

// ---- M-091: the token bucket itself (request-guards.ts) and the API limiter built on it (api-rate.ts). The route-level 429s are in
// api-rate-limit.test.ts and request-guards.test.ts; these pin the arithmetic they rely on.
describe('M-091 token bucket', () => {
  it('allows exactly `burst` immediately, then answers the whole seconds to wait', () => {
    const b = new Buckets(2, 3);
    expect([0, 0, 0].map(() => b.take('k', 1000))).toEqual([0, 0, 0]);
    expect(b.take('k', 1000)).toBe(1); // 0 tokens, 2/s: 0.5 s rounds UP to 1 s
    const slow = new Buckets(0.25, 1);
    expect(slow.take('k', 0)).toBe(0);
    expect(slow.take('k', 0)).toBe(4); // 1 token at 0.25/s
  });
  it('refills with elapsed time and never past the burst', () => {
    const b = new Buckets(1, 2);
    b.take('k', 0);
    b.take('k', 0);
    expect(b.take('k', 0)).toBeGreaterThan(0);
    expect(b.take('k', 1000)).toBe(0); // one second = one token back
    expect(b.take('k', 1000)).toBeGreaterThan(0);
    // a long idle gap refills to the burst, not beyond it
    expect([b.take('k', 3_600_000), b.take('k', 3_600_000), b.take('k', 3_600_000)]).toEqual([0, 0, expect.any(Number)]);
    expect(b.take('k', 3_600_000)).toBeGreaterThan(0);
  });
  it('keys are independent', () => {
    const b = new Buckets(0.001, 1);
    expect(b.take('a', 0)).toBe(0);
    expect(b.take('a', 0)).toBeGreaterThan(0);
    expect(b.take('b', 0)).toBe(0);
  });
  it('is bounded: past maxKeys the OLDEST key is dropped (it starts full again), recent keys keep their state', () => {
    const b = new Buckets(0.001, 1, 2);
    b.take('a', 0);
    b.take('b', 0);
    b.take('c', 0); // evicts a
    expect(b.take('b', 0)).toBeGreaterThan(0); // still empty
    expect(b.take('a', 0)).toBe(0); // forgotten: full bucket
  });
});

describe('M-091 takeApiToken', () => {
  it('checks the integrator client first, so a flooding client cannot drain its workspace; the workspace bucket still caps everything', () => {
    const prev = configureApiLimits({ workspace: { ratePerSec: 0.0001, burst: 3 }, integration: { ratePerSec: 0.0001, burst: 1 } });
    try {
      expect(takeApiToken('ws-rate-1', 'client-a')).toBe(0); // spends client-a's token and 1 workspace token
      expect(takeApiToken('ws-rate-1', 'client-a')).toBeGreaterThan(0); // client refused ...
      expect(takeApiToken('ws-rate-1', null)).toBe(0); // ... without costing the workspace a token: 2 left, a person still gets in
      expect(takeApiToken('ws-rate-1', 'client-b')).toBe(0); // another client, last workspace token
      expect(takeApiToken('ws-rate-1', null)).toBeGreaterThan(0); // workspace exhausted
      expect(takeApiToken('ws-rate-2', null)).toBe(0); // another workspace is unaffected
    } finally {
      configureApiLimits(prev);
    }
    expect(prev).toEqual(DEFAULT_API_LIMITS);
  });
});

// ---- M-121: digest window edges and the counters digest.test.ts does not seed (handoffs, campaign recipients, opt-outs).
describe('M-121 digestCounts', () => {
  const NOW = 1_800_000_000_000;
  const WEEK = 7 * 86_400_000;
  it('the window is [now - 7d, now): the lower edge counts, the upper edge does not', async () => {
    const ws = 'ws-dg-edge';
    const conv = await openChat(ws, '201001234567');
    const put = (wamid: string, at: number) =>
      exec(ws, "INSERT INTO messages (wamid, conversation_id, direction, type, preview, status, author, created_at, updated_at) VALUES (?, ?, 'in', 'text', 'x', 'received', 'c', ?, 0)", wamid, conv, at);
    await put('dg.edge.lo', NOW - WEEK); // included
    await put('dg.edge.below', NOW - WEEK - 1); // excluded
    await put('dg.edge.hi', NOW); // excluded
    await put('dg.edge.in', NOW - 1); // included
    const c = await runInDurableObject(workspace(ws), (_i, s) => digestCounts(s.storage.sql, NOW));
    expect(c).toMatchObject({ from: NOW - WEEK, to: NOW, messagesIn: 2, customersWrote: 1 });
  });
  it('counts handoffs started, queued campaign recipients (not skipped) and opt-outs inside the window only', async () => {
    const ws = 'ws-dg-more';
    await openChat(ws, '201001234567');
    await openChat(ws, '201001234568');
    const id = (await rows<{ id: number }>(ws, 'SELECT id FROM contacts ORDER BY id'))[0]!.id;
    const id2 = (await rows<{ id: number }>(ws, 'SELECT id FROM contacts ORDER BY id'))[1]!.id;
    await exec(ws, "INSERT INTO agent_handoffs (wa_id, started_at, until_at, reason) VALUES ('h1', ?, ?, 'r'), ('h2', ?, ?, 'r')", NOW - 1000, NOW, NOW - WEEK - 5, NOW);
    await exec(ws, "INSERT INTO campaign_recipients (campaign_id, contact_id, page, idem, state, at) VALUES ('c1', ?, 0, 'i1', 'queued', ?), ('c1', ?, 0, 'i2', 'skipped', ?), ('c2', ?, 0, 'i3', 'queued', ?)", id, NOW - 10, id2, NOW - 10, id, NOW - WEEK - 10);
    await exec(ws, 'UPDATE contacts SET opted_out_at = ? WHERE id = ?', NOW - 20, id);
    await exec(ws, 'UPDATE contacts SET opted_out_at = ? WHERE id = ?', NOW - WEEK - 20, id2);
    const c = await runInDurableObject(workspace(ws), (_i, s) => digestCounts(s.storage.sql, NOW));
    expect(c).toMatchObject({ handoffs: 1, campaignRecipients: 1, optOuts: 1 });
  });
});

// ---- M-021: erasing a person ends every unfinished import and deletes its uploaded CSV through the real R2 + DO path
// (privacy-w1 B1 covers a 'pending' import; contacts-import.test.ts covers the normal end-of-import delete).
describe('M-021 erasure and uploaded CSVs', () => {
  const PHONE = '201001234567';
  const mk = async (ws: string, id: string, status: 'pending' | 'running' | 'done', body: string | null) => {
    const key = `imports/${ws}/${id}.csv`;
    if (body !== null) await env.MEDIA.put(key, body);
    await workspace(ws).createImport({ id, filename: `${id}.csv`, r2Key: key, size: 20, consented: false, mapping: null, actor: 'u' });
    if (status !== 'pending') await exec(ws, 'UPDATE imports SET status = ? WHERE id = ?', status, id);
    return key;
  };
  const seedContact = (ws: string) => workspace(ws).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `${ws}.1`, from: PHONE, ts: 1, type: 'text', text: 'hi' }], statuses: [], receivedAt: 1 });

  it('a RUNNING import is failed with contact_erased and its CSV is gone; a finished import row and its rejects are left alone', async () => {
    const ws = 'ws-era-run';
    await mk(ws, 'fin', 'done', null); // only one import may be unfinished at a time, so the finished one is made first
    const running = await mk(ws, 'run', 'running', `phone\n${PHONE}\n`);
    await exec(ws, "INSERT INTO import_rejects (import_id, line, reason) VALUES ('fin', 3, 'invalid_phone')");
    await seedContact(ws);
    const r = await workspace(ws).eraseContact(PHONE);
    expect(r.found).toBe(true);
    expect(await env.MEDIA.get(running)).toBeNull();
    expect(await rows(ws, 'SELECT id, status, error FROM imports ORDER BY id')).toEqual([
      { id: 'fin', status: 'done', error: null },
      { id: 'run', status: 'failed', error: 'contact_erased' },
    ]);
    expect(await rows(ws, 'SELECT import_id, line FROM import_rejects')).toEqual([{ import_id: 'fin', line: 3 }]);
    expect(await rows(ws, 'SELECT key FROM r2_pending_deletes')).toEqual([]);
  });

  it('when R2 refuses the delete, the CSV key stays queued for retry (never forgotten) and the erasure reports it', async () => {
    const ws = 'ws-era-r2';
    const key = await mk(ws, 'live', 'running', `phone\n${PHONE}\n`);
    await seedContact(ws);
    vi.spyOn(env.MEDIA, 'delete').mockRejectedValue(new Error('r2 down'));
    const r = await workspace(ws).eraseContact(PHONE);
    expect(r.r2Pending).toBeGreaterThanOrEqual(1);
    expect((await rows<{ key: string }>(ws, 'SELECT key FROM r2_pending_deletes')).map((x) => x.key)).toContain(key);
    expect(await rows(ws, "SELECT status, error FROM imports WHERE id = 'live'")).toEqual([{ status: 'failed', error: 'contact_erased' }]);
  });
});
