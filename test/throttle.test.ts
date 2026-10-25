import { SELF } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { bucketDecision, TIER_LIMITS } from '../src/core/throttle';
import type { SendJob } from '../src/core/send-queue';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { tierPayload } from './helpers/payload';
import { consume } from './helpers/queue';
import { exec, openChat, own, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const PN = 'pn-th';
const job = (ws: string, to: string, key: string): SendJob => ({ workspaceId: ws, phoneNumberId: PN, to, text: 'x', idempotencyKey: key });
const waitingTasks = (ws: string) => rows<{ payload: string }>(ws, "SELECT payload FROM scheduled_tasks WHERE kind = 'send_release'");

it('token bucket math: refills at mps up to a one-second burst, and says how long to wait', () => {
  expect(bucketDecision(2, 2, 1000, 1000)).toEqual({ ok: true, tokens: 1 });
  expect(bucketDecision(0, 80, 1000, 1000)).toEqual({ ok: false, delayMs: 13 });
  expect(bucketDecision(0, 2, 1500, 1000)).toEqual({ ok: true, tokens: 0 }); // 0.5 s * 2/s = 1 token
  expect(bucketDecision(0, 10, 1000 + 60_000, 1000)).toEqual({ ok: true, tokens: 9 }); // capped at mps
  expect(TIER_LIMITS.TIER_250).toBe(250);
});

it('Review Focus 1: a burst of 500 on a 250-tier number: replies go, new recipients beyond the tier wait and are reported, nothing is dropped', { timeout: 120_000 }, async () => {
  const ws = 'ws-t1';
  const stub = workspace(ws);
  await own(ws, PN);
  await stub.setNumberLimits(PN, { tier: 250, mps: 100_000 });
  const now = Date.now();
  const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => openChat(ws, `2010100000${String(i).padStart(2, '0')}`)));
  expect(replies).toHaveLength(20);
  const results: string[] = [];
  for (let i = 0; i < 20; i++) results.push(await stub.claimSend(job(ws, `2010100000${String(i).padStart(2, '0')}`, `reply:r${i}`), now));
  for (let i = 0; i < 500; i++) results.push(await stub.claimSend(job(ws, `20120${String(i).padStart(7, '0')}`, `reply:n${i}`), now));
  const count = (r: string) => results.filter((x) => x === r).length;
  expect(count('claimed')).toBe(20 + 250);
  expect(count('deferred')).toBe(250);
  expect(count('dropped')).toBe(0);
  // nothing lost: every one of the 500 has a message row, the deferred ones are queued and each has a release task
  expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key LIKE 'reply:n%'")).toEqual([{ n: 500 }]);
  expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE status = 'queued'")).toEqual([{ n: 250 }]);
  expect(await waitingTasks(ws)).toHaveLength(250);
  expect(await stub.throttleReport(PN, now)).toMatchObject({ tier: 250, usedInWindow: 250, waiting: 250 });
  // replies keep flowing while the tier is exhausted, and a recipient already counted today can be messaged again
  expect(await stub.claimSend(job(ws, '201010000000', 'reply:again'), now)).toBe('claimed');
  expect(await stub.claimSend(job(ws, '201200000000', 'reply:n0-again'), now)).toBe('claimed');
  // a day later the tier has recovered: the waiting jobs are released to the queue and now go through
  const later = now + 24 * 3600_000 + 60_000;
  const spy = vi.mocked(env.SEND_QUEUE.sendBatch);
  spy.mockClear();
  expect(await stub.runDueTasks(later)).toMatchObject({ failed: 0 });
  const released = spy.mock.calls.flatMap((c) => (c[0] as { body: SendJob }[]).map((m) => m.body));
  expect(released).toHaveLength(250);
  const second: string[] = [];
  for (const j of released) second.push(await stub.claimSend(j, later));
  expect(second.filter((x) => x === 'claimed')).toHaveLength(250);
});

it('a throughput-limited job is delayed by the time it takes the bucket to refill, then goes', async () => {
  const ws = 'ws-t2';
  const stub = workspace(ws);
  await own(ws, PN);
  await stub.setNumberLimits(PN, { mps: 2 });
  await openChat(ws);
  const now = Date.now();
  const out = [await stub.claimSend(job(ws, '201001234567', 'reply:a'), now), await stub.claimSend(job(ws, '201001234567', 'reply:b'), now), await stub.claimSend(job(ws, '201001234567', 'reply:c'), now)];
  expect(out).toEqual(['claimed', 'claimed', 'deferred']);
  const [task] = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(task!.due_at).toBe(now + 500);
  expect(JSON.parse(task!.payload).reason).toBe('throughput');
  expect(await stub.claimSend(job(ws, '201001234567', 'reply:c'), now + 500)).toBe('claimed');
});

it('131049 reschedules that recipient +24 h and never marks the contact bad; a third strike fails it', async () => {
  const ws = W(120);
  const api = await apiFor(ws);
  const conv = await openChat(ws);
  await exec(ws, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', '[{\"type\":\"BODY\",\"text\":\"عرض\"}]', 1)");
  await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: '00000000-0000-4000-8000-000000000131', name: 'promo', language: 'ar', params: [] });
  // Pick this send by its key: another workspace's alarm may hand an unrelated job to the same spy at any moment.
  const queued = vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.flatMap((c) => c[0] as { body: SendJob }[]).filter((m) => m.body.idempotencyKey === 'ui:00000000-0000-4000-8000-000000000131');
  expect(queued).toHaveLength(1); // the filter must not hide a double enqueue of this send
  const g = graphStub(() => ({ status: 400, json: { error: { code: 131049, message: 'frequency cap' } } }));
  const res = await consume([queued[0]!.body]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(g.calls).toHaveLength(1);
  expect(await rows(ws, "SELECT opted_out_at, consent_source FROM contacts")).toEqual([{ opted_out_at: null, consent_source: null }]);
  expect(await rows(ws, "SELECT status, error_code FROM messages WHERE direction = 'out'")).toEqual([{ status: 'queued', error_code: 131049 }]);
  const [t] = await rows<{ due_at: number; payload: string }>(ws, "SELECT due_at, payload FROM scheduled_tasks WHERE kind = 'send_release'");
  expect(t!.due_at).toBeGreaterThan(Date.now() + 23.9 * 3600_000);
  expect(JSON.parse(t!.payload)).toMatchObject({ reason: 'frequency_cap', job: { deferrals: 1 } });
  // 24 h later the release goes back to the queue; after the cap strikes again it is rescheduled once more, then failed
  const stub = workspace(ws);
  const j1 = JSON.parse(t!.payload).job as SendJob;
  expect(await stub.rescheduleFrequencyCap({ ...j1, deferrals: 1 })).toBe('rescheduled');
  expect(await stub.rescheduleFrequencyCap({ ...j1, deferrals: 2 })).toBe('failed');
  expect(await rows(ws, "SELECT status FROM messages WHERE direction = 'out'")).toEqual([{ status: 'failed' }]);
});

it("a tier webhook updates the number's limit", async () => {
  await seedNumber('pn-tier', 'ws-t4', 'active', 'waba-tier', '+20 100 123 4567');
  expect((await postWebhook(SELF, tierPayload('waba-tier', '201001234567', 'UPGRADE', 'TIER_10K'))).status).toBe(200);
  expect(await workspace('ws-t4').throttleReport('pn-tier')).toMatchObject({ tier: 10_000 });
  await postWebhook(SELF, tierPayload('waba-tier', '201001234567', 'DOWNGRADE', 'TIER_1K'));
  expect(await workspace('ws-t4').throttleReport('pn-tier')).toMatchObject({ tier: 1000 });
});

it('GET /throttle reports tier use for the active number', async () => {
  const ws = W(121);
  const api = await apiFor(ws);
  const res = await api.call('GET', '/throttle');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ tier: 250, mps: 80, usedInWindow: 0, waiting: 0 });
});
