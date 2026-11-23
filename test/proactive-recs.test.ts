import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_CAP_MS, SEND_DELAY_MS, inQuietHours, quietEnd } from '../src/core/store-link/proactive-recs';
import { apiFor, useApiKey } from './helpers/api';
import { fund, setupBilling } from './helpers/billing';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { exec, openChat, rows, workspace } from './helpers/workspace';

/** CHAT-RECS-SWITCH-1: proactive post-order product suggestions. Every gate has a test that fails when the gate is removed. */
useApiKey();
const link = useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000081${String(n).padStart(2, '0')}`;
const TZ = 'Africa/Cairo';
const TEMPLATE = 'cart_recovery'; // an approved MARKETING template with two body variables, as the real one has

/** The first moment at least `SEND_DELAY_MS` away that is 12:00 in Cairo (never quiet hours), so a run is deterministic whatever time the suite runs. */
function noonAfter(from: number): number {
  let t = from + SEND_DELAY_MS + 60_000;
  while (new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).format(t) !== '12:00') t += 60_000;
  return t;
}
const created = (ws: string, orderId: string, extra: Record<string, unknown> = {}) =>
  storeEvent(ws, 'order.created', { orderId, orderNumber: `N-${orderId}`, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 5000, currency: 'EGP', paymentMethod: 'link', channel: 'web', ...extra });
const outcomes = (ws: string) => rows<{ order_id: string; recs_outcome: string | null }>(ws, 'SELECT order_id, recs_outcome FROM store_orders ORDER BY order_id');
const recsJobs = async (ws: string) => (await flush(ws)).filter((j) => j.idempotencyKey.startsWith('recs:'));
const runAt = (ws: string, t: number) => workspace(ws).runDueTasks(t);

async function shop(ws: string, o: { on?: boolean; template?: string | null; consent?: boolean; optedOut?: boolean; orderIds?: string[] } = {}) {
  await storeWorkspace(ws);
  link.fake.recs.v1 = ['v2', 'v3', 'v4', 'v5'];
  for (const id of o.orderIds ?? ['o1']) link.fake.orders.set(id, { orderId: id, orderNumber: `N-${id}`, buyerKey: BUYER_KEY_1, status: 'confirmed', paymentMethod: 'link', lines: [{ variantId: 'v1', quantity: 1 }], totalMinor: 5000, currency: 'EGP', at: Date.now(), proofs: [], codOutcome: null, instapayReference: null });
  await openChat(ws, WA_1);
  if (o.consent !== false) await exec(ws, "UPDATE contacts SET consent_at = ?, consent_source = 'opt_in' WHERE wa_id = ?", Date.now() - 1000, WA_1);
  if (o.optedOut) await exec(ws, 'UPDATE contacts SET opted_out_at = ? WHERE wa_id = ?', Date.now(), WA_1);
  if (o.template !== null) await workspace(ws).setProactiveRecs({ templateName: o.template ?? TEMPLATE });
  if (o.on) await workspace(ws).setProactiveRecs({ enabled: true });
}

describe('the switch', () => {
  it('is OFF by default: an order schedules nothing, calls the Store for nothing, sends nothing, holds no wallet credit', async () => {
    const ws = W(1);
    await shop(ws);
    await setupBilling(ws);
    await fund(ws, 100_000);
    expect(await workspace(ws).getProactiveRecs()).toMatchObject({ enabled: false, templateName: TEMPLATE });
    await deliver([created(ws, 'o1')]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'proactive_recs'")).toEqual([]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
    expect(await rows(ws, "SELECT 1 FROM wallet_holds WHERE ref LIKE 'msg:recs:%'")).toEqual([]);
  });

  it('switching it OFF after the order but before the send stops the send (the gate is re-read when the task runs) and says why', async () => {
    const ws = W(2);
    await shop(ws, { on: true });
    await deliver([created(ws, 'o1')]);
    await workspace(ws).setProactiveRecs({ enabled: false });
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:switch_off' }]);
  });

  it('ON needs a template name; a bad name is refused; the owner alone can change it', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    expect(await workspace(ws).setProactiveRecs({ enabled: true })).toEqual({ ok: false, reason: 'template_required' });
    expect(await workspace(ws).setProactiveRecs({ templateName: 'Has Space', enabled: true })).toEqual({ ok: false, reason: 'invalid_template' });
    expect((await workspace(ws).getProactiveRecs()).enabled).toBe(false);
    const owner = await apiFor(ws);
    expect((await owner.call('PUT', '/proactive-recs', { enabled: true })).status).toBe(400);
    expect((await owner.call('PUT', '/proactive-recs', { enabled: true, templateName: TEMPLATE })).status).toBe(200);
    expect(await (await owner.call('GET', '/proactive-recs')).json()).toMatchObject({ enabled: true, templateName: TEMPLATE, suggestions: 3, capDays: 14 });
    expect((await owner.call('PUT', '/proactive-recs', { enabled: 'yes' })).status).toBe(400);
    const staff = await apiFor(ws, 'staff');
    expect((await staff.call('PUT', '/proactive-recs', { enabled: false })).status).toBe(403);
    expect((await staff.call('GET', '/proactive-recs')).status).toBe(403);
    expect((await workspace(ws).getProactiveRecs()).enabled).toBe(true);
  });
});

describe('the gates', () => {
  it('no template configured: nothing is sent (recorded no_template)', async () => {
    const ws = W(10);
    await shop(ws, { template: null });
    await exec(ws, "INSERT INTO store_state (key, value) VALUES ('proactive_recs.enabled', '1')"); // forced on without a name: the task still refuses
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:no_template' }]);
  });

  it('a template Meta has not approved: nothing is sent and no wallet credit is held', async () => {
    const ws = W(11);
    await shop(ws, { on: true, template: 'recs_not_approved_yet' });
    await setupBilling(ws);
    await fund(ws, 100_000);
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:template_not_approved' }]);
    expect(await rows(ws, "SELECT 1 FROM wallet_holds WHERE ref LIKE 'msg:recs:%'")).toEqual([]);
  });

  it('no marketing consent on record: nothing is sent, the Store is not asked, and the reason is recorded', async () => {
    const ws = W(12);
    await shop(ws, { on: true, consent: false });
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:no_consent' }]);
  });

  it('consent given only at the Store checkout does not count until the customer has written to us (the campaign rule)', async () => {
    const ws = W(13);
    await shop(ws, { on: true });
    await exec(ws, "UPDATE contacts SET consent_source = 'store_checkout', last_inbound_at = NULL WHERE wa_id = ?", WA_1);
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:no_consent' }]);
  });

  it('a customer who sent STOP gets nothing, whatever consent they gave before', async () => {
    const ws = W(14);
    await shop(ws, { on: true, optedOut: true });
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:opted_out' }]);
  });

  it('quiet hours defer the send to the first morning minute instead of dropping it; nothing goes out while quiet', async () => {
    const ws = W(15);
    await shop(ws, { on: true });
    await deliver([created(ws, 'o1')]);
    let night = Date.now() + SEND_DELAY_MS;
    while (!inQuietHours(night, TZ) || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: 'numeric' }).format(night) !== '23') night += 15 * 60_000; // 23:xx Cairo
    await runAt(ws, night);
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: null }]); // not decided: still pending
    const due = await rows<{ due_at: number }>(ws, "SELECT due_at FROM scheduled_tasks WHERE kind = 'proactive_recs'");
    expect(due).toHaveLength(1);
    expect(due[0]!.due_at).toBe(quietEnd(night, TZ));
    expect(inQuietHours(due[0]!.due_at, TZ)).toBe(false);
    await runAt(ws, due[0]!.due_at);
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1']);
  });

  it('per-customer frequency cap: a second order inside the window gets nothing; after the window the next one is sent', async () => {
    const ws = W(16);
    await shop(ws, { on: true, orderIds: ['o1', 'o2', 'o3'] });
    const t = noonAfter(Date.now());
    await deliver([created(ws, 'o1')]);
    await runAt(ws, t);
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1']);
    await deliver([created(ws, 'o2')]);
    await runAt(ws, t + 3_600_000);
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1']);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'sent' }, { order_id: 'o2', recs_outcome: 'skipped:frequency_cap' }]);
    await deliver([created(ws, 'o3')]);
    await runAt(ws, noonAfter(t + CUSTOMER_CAP_MS));
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1', 'recs:o3']);
  });

  it('nothing in stock to suggest: nothing is sent', async () => {
    const ws = W(17);
    await shop(ws, { on: true });
    link.fake.stock.v2 = link.fake.stock.v3 = link.fake.stock.v4 = link.fake.stock.v5 = 0;
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:nothing_to_suggest' }]);
  });

  it('a cancelled order gets no suggestion', async () => {
    const ws = W(18);
    await shop(ws, { on: true });
    await deliver([created(ws, 'o1')]);
    await exec(ws, "UPDATE store_orders SET status = 'cancelled' WHERE order_id = 'o1'");
    await runAt(ws, noonAfter(Date.now()));
    expect(await recsJobs(ws)).toEqual([]);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'skipped:order_not_active' }]);
  });
});

describe('the send', () => {
  it('queues ONE template with up to 3 in-stock products from the Store engine, in the buyer language, billed through the wallet hold', async () => {
    const ws = W(30);
    await shop(ws, { on: true });
    await setupBilling(ws);
    await fund(ws, 100_000);
    link.fake.stock.v3 = 0;
    await deliver([created(ws, 'o1')]);
    await runAt(ws, noonAfter(Date.now()));
    const jobs = await recsJobs(ws);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: 'template', to: WA_1, idempotencyKey: 'recs:o1', template: { name: TEMPLATE } });
    const body = jobs[0]!.template!.components[0]!.parameters.map((p) => p.text);
    expect(body[0]).toBeTruthy();
    expect(body[1]!.split(' - ')).toHaveLength(3); // v2, v4, v5 (v3 is out of stock)
    expect(body[1]).not.toContain('v3');
    expect(link.fake.lastCall('getRecommendations')).toEqual([ws, expect.objectContaining({ seedIds: [], orderNumber: 'N-o1', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, mode: 'complement' })]);
    expect(await rows(ws, "SELECT state FROM wallet_holds WHERE ref = 'msg:recs:o1'")).toHaveLength(1); // the wallet spoke first, once
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'sent' }]);
  });

  it('is idempotent per order: the same order redelivered (new envelope) or the task run twice sends once', async () => {
    const ws = W(31);
    await shop(ws, { on: true });
    const t = noonAfter(Date.now());
    await deliver([created(ws, 'o1')]);
    await deliver([created(ws, 'o1')]); // a second envelope for the same order
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) SELECT kind, due_at, payload FROM scheduled_tasks WHERE kind = 'proactive_recs' LIMIT 1"); // a duplicate task row
    await runAt(ws, t);
    await runAt(ws, t + 1000);
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1']);
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key = 'recs:o1'")).toEqual([{ n: 1 }]);
  });

  it('fails fast: when queueing throws, the order is marked failed and no queued message is left behind', async () => {
    const ws = W(32);
    await shop(ws, { on: true });
    await deliver([created(ws, 'o1')]);
    await runInDurableObject(workspace(ws), (_i, state) => {
      // A trigger that makes the outbound insert fail: the whole queueing transaction must roll back.
      state.storage.sql.exec("CREATE TRIGGER fail_recs BEFORE INSERT ON messages WHEN NEW.idempotency_key LIKE 'recs:%' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    });
    await runAt(ws, noonAfter(Date.now()));
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: 'failed:enqueue' }]);
    expect(await rows(ws, "SELECT 1 FROM messages WHERE idempotency_key = 'recs:o1'")).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.job.idempotencyKey') = 'recs:o1'")).toEqual([]);
    expect(await recsJobs(ws)).toEqual([]);
  });

  it('a Store outage retries (the order stays undecided), then gives up with a recorded reason', async () => {
    const ws = W(33);
    await shop(ws, { on: true });
    await deliver([created(ws, 'o1')]);
    const t = noonAfter(Date.now());
    link.fake.failNext.set('getRecommendations', 'unavailable');
    await runAt(ws, t);
    expect(await outcomes(ws)).toEqual([{ order_id: 'o1', recs_outcome: null }]);
    expect(await rows(ws, "SELECT attempts FROM scheduled_tasks WHERE kind = 'proactive_recs'")).toEqual([{ attempts: 1 }]);
    await runAt(ws, t + 3_600_000);
    expect((await recsJobs(ws)).map((j) => j.idempotencyKey)).toEqual(['recs:o1']);
  });
});
