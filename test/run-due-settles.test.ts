import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { holdPoint } from './helpers/hold';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, iso, sentJobs, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { openChat, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000062${String(n).padStart(2, '0')}`;
useStoreLink();

// Root cause of the intermittent CI failures (PRs #5-#9): a hand-over due at once is sometimes claimed by the workspace's own alarm first.
// A caller of runDueTasks must then wait for that in-flight alarm run, not return early with the job still on its way.
it('runDueTasks waits for a run the alarm already started, so the caller sees the hand-over it was due', async () => {
  const ws = W(1);
  await storeWorkspace(ws);
  await openChat(ws, WA_1);
  await deliver([storeEvent(ws, 'order.created', { orderId: 'o9', orderNumber: '9009', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 1, currency: 'EGP', paymentMethod: 'instapay', channel: 'whatsapp' })]);
  await deliver([storeEvent(ws, 'order.status_changed', { orderId: 'o9', status: 'paid', updatedAt: iso() })]);
  const h = holdPoint();
  vi.mocked(env.SEND_QUEUE.sendBatch).mockImplementationOnce(async () => { await h.hold(); return {} as never; });
  const alarm = runDurableObjectAlarm(workspace(ws)); // the alarm claims the hand-over and blocks in the queue call
  await h.reached();
  let returned = false;
  const run = workspace(ws).runDueTasks().then(() => { returned = true; });
  await new Promise((r) => setTimeout(r, 50));
  expect(returned).toBe(false); // it did not return while the alarm still held the hand-over
  h.release();
  await run;
  await alarm;
  expect(sentJobs().filter((j) => j.workspaceId === ws).map((j) => j.idempotencyKey)).toContain('order:o9:paid');
});
