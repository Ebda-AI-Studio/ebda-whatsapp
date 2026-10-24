import { SELF, env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import type { SendJob } from '../src/core/send-queue';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { consume } from './helpers/queue';
import { openChat, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const queuedJobs = () => vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.flatMap((c) => (c[0] as { body: SendJob }[]).map((m) => m.body));

it('a queued auto-reply whose contact was erased is dropped: no Meta call, no contact or message re-created', async () => {
  const store = W(500);
  await seedNumber('pn-ef1', store);
  await postWebhook(SELF, inboundPayload('pn-ef1', [{ id: 'wamid.ef1', text: 'مرحبا' }]));
  const [reply] = queuedJobs();
  expect(reply).toMatchObject({ idempotencyKey: 'reply:wamid.ef1' });
  await workspace(store).eraseContact('201001234567');
  const g = graphStub();
  const res = await consume([reply!]);
  expect(res.explicitAcks).toEqual(['m0']);
  expect(g.calls).toHaveLength(0);
  expect(await rows(store, 'SELECT 1 FROM contacts')).toEqual([]);
  expect(await rows(store, 'SELECT 1 FROM messages')).toEqual([]);
});

it('an API send queued before the contact was erased is dropped too', async () => {
  const store = W(501);
  const api = await apiFor(store, 'owner', 'pn-ef2');
  const conv = await openChat(store);
  await api.call('POST', `/conversations/${conv}/messages`, { type: 'text', clientId: '00000000-0000-4000-8000-000000000501', text: 'تأكيد' });
  const [job] = queuedJobs();
  await workspace(store).eraseContact('201001234567');
  const g = graphStub();
  expect((await consume([job!])).explicitAcks).toEqual(['m0']);
  expect(g.calls).toHaveLength(0);
  expect(await rows(store, 'SELECT 1 FROM contacts')).toEqual([]);
});

it('sends delayed by the throttle are cancelled with the contact they were for', async () => {
  const store = W(502);
  const ws = workspace(store);
  await ws.setNumberLimits('pn-x', { mps: 1 });
  await openChat(store);
  const job = (key: string): SendJob => ({ workspaceId: store, phoneNumberId: 'pn-x', to: '201001234567', text: 'سري', idempotencyKey: key });
  const now = Date.now();
  await ws.claimSend(job('reply:a'), now);
  expect(await ws.claimSend(job('reply:b'), now)).toBe('deferred');
  expect(await rows(store, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toHaveLength(1);
  await ws.eraseContact('201001234567');
  expect(await rows(store, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release'")).toEqual([]);
  expect(await rows(store, 'SELECT payload FROM scheduled_tasks WHERE payload IS NOT NULL')).toEqual([]);
});

it('the tombstones hold no personal data', async () => {
  const store = W(503);
  await openChat(store, '201001239876', { wamid: 'wamid.tomb' });
  await workspace(store).eraseContact('201001239876');
  const keys = await rows<{ key: string }>(store, 'SELECT key FROM erased_keys');
  expect(keys.map((k) => k.key)).toEqual(['reply:wamid.tomb']);
  expect(JSON.stringify(keys)).not.toContain('2010');
});
