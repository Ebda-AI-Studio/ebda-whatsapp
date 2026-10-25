import { describe, expect, it, vi } from 'vitest';
import { BUYER_KEY_1, PHONE_1, WA_1, deliver, flush, iso, storeEvent, storeWorkspace, useStoreLink } from './helpers/store-link';
import { segmentCriteria } from '../src/core/api/contract';
import { exec, openChat, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000098${String(n).padStart(2, '0')}`;
const link = useStoreLink();
const abandoned = (ws: string, cartId: string, at = iso()) =>
  storeEvent(ws, 'cart.abandoned', { cartId, buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', recoveryUrl: 'https://shop.example/cart/x' }, { occurredAt: at });
const changed = (ws: string, marketingOptIn: boolean, at = iso()) => storeEvent(ws, 'customer.consent_changed', { buyerKey: BUYER_KEY_1, marketingOptIn, at });
const consent = (ws: string) => rows<{ consent_source: string | null; consent_at: number | null; opted_out_at: number | null }>(ws, 'SELECT consent_source, consent_at, opted_out_at FROM contacts WHERE wa_id = ?', WA_1);
const keyed = (ws: string) => exec(ws, 'UPDATE contacts SET buyer_key = ? WHERE wa_id = ?', BUYER_KEY_1, WA_1);
const sentOptOut = async (ws: string) => {
  await workspace(ws).runDueTasks();
  return link.sink.sent.filter((e) => e.type === 'whatsapp.opt_out_changed').map((e) => ({ ...e.data }));
};
const say = (ws: string, text: string, n: number) => openChat(ws, WA_1, { text, ts: Math.floor(Date.now() / 1000) + n, wamid: `wamid.${ws}.${n}` });

describe('checkout attestation (cart.abandoned)', () => {
  it('records store_checkout consent at the event time and sends the reminder', async () => {
    const ws = W(1);
    await storeWorkspace(ws);
    const at = Date.now() - 60_000;
    await deliver([abandoned(ws, 'c1', iso(at))]);
    expect(await consent(ws)).toEqual([{ consent_source: 'store_checkout', consent_at: at, opted_out_at: null }]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toContain('cart:c1');
  });

  it('does not override an opt-out', async () => {
    const ws = W(2);
    await storeWorkspace(ws);
    await say(ws, 'stop', 1);
    const before = await consent(ws);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver([abandoned(ws, 'c1')]);
    expect(await consent(ws)).toEqual(before);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).not.toContain('cart:c1');
  });
});

describe('opt-out to the Store (whatsapp.opt_out_changed)', () => {
  it('STOP emits optedOut=true v1, START false v2, a repeated STOP nothing', async () => {
    const ws = W(3);
    await storeWorkspace(ws);
    await say(ws, 'hello', 1);
    await keyed(ws);
    await say(ws, 'stop', 2);
    expect(await sentOptOut(ws)).toEqual([{ buyerKey: BUYER_KEY_1, optedOut: true, at: expect.any(String), version: 1 }]);
    await say(ws, 'STOP', 3);
    expect(await sentOptOut(ws)).toHaveLength(1);
    await say(ws, 'start', 4);
    const all = await sentOptOut(ws);
    expect(all.map((d) => [d.optedOut, d.version])).toEqual([[true, 1], [false, 2]]);
    await say(ws, 'start', 5);
    expect(await sentOptOut(ws)).toHaveLength(2);
  });

  it('emits nothing when no buyerKey is known for the contact', async () => {
    const ws = W(4);
    await storeWorkspace(ws);
    await say(ws, 'stop', 1);
    expect(await sentOptOut(ws)).toEqual([]);
  });
});

describe('customer.consent_changed', () => {
  it('false stops marketing but not utility messages', async () => {
    const ws = W(5);
    await storeWorkspace(ws);
    await deliver([abandoned(ws, 'c1')]);
    await flush(ws);
    await deliver([changed(ws, false, iso(Date.now() + 1000))]);
    expect(await consent(ws)).toEqual([{ consent_source: 'store_revoked', consent_at: null, opted_out_at: null }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver([storeEvent(ws, 'cart.abandoned', { cartId: 'c2', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', recoveryUrl: 'https://shop.example/cart/y' }, { occurredAt: iso(Date.now() - 5000) })]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).not.toContain('cart:c2');
    await deliver([storeEvent(ws, 'order.created', { orderId: 'o1', orderNumber: '1001', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', totalMinor: 100, currency: 'EGP', paymentMethod: 'instapay', channel: 'web' })]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toContain('order:o1:created');
  });

  it('true records consent but never overrides a WhatsApp STOP', async () => {
    const ws = W(6);
    await storeWorkspace(ws);
    await say(ws, 'hello', 1);
    await keyed(ws);
    const at = Date.now() + 1000;
    expect((await deliver([changed(ws, true, iso(at))])).explicitAcks).toEqual(['e0']);
    expect(await consent(ws)).toMatchObject([{ consent_source: 'store_checkout', consent_at: at, opted_out_at: null }]);
    await say(ws, 'stop', 2);
    const stopped = await consent(ws);
    await deliver([changed(ws, true, iso(at + 5000))]);
    expect(await consent(ws)).toEqual(stopped);
  });

  it('ignores an event older than the last applied one', async () => {
    const ws = W(7);
    await storeWorkspace(ws);
    await say(ws, 'hello', 1);
    await keyed(ws);
    const t = Date.now();
    await deliver([changed(ws, false, iso(t + 2000))]);
    await deliver([changed(ws, true, iso(t + 1000))]);
    expect(await consent(ws)).toEqual([{ consent_source: 'store_revoked', consent_at: null, opted_out_at: null }]);
  });

  it('for an unknown buyer stores nothing and is skipped', async () => {
    const ws = W(8);
    await storeWorkspace(ws);
    await deliver([changed(ws, true)]);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM entity_versions WHERE entity LIKE 'consent:%'")).toEqual([]);
  });
});

describe('erasure', () => {
  it('removes the per-buyer consent and opt-out state', async () => {
    const ws = W(9);
    await storeWorkspace(ws);
    await say(ws, 'hello', 1);
    await keyed(ws);
    await deliver([changed(ws, true)]);
    await say(ws, 'stop', 2);
    expect(await rows(ws, "SELECT 1 FROM entity_versions WHERE entity LIKE 'consent:%'")).toHaveLength(1);
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'optver:%'")).toHaveLength(1);
    await deliver([storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 })]);
    expect(await rows(ws, "SELECT 1 FROM entity_versions WHERE entity LIKE 'consent:%'")).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'optver:%'")).toEqual([]);
    expect(await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'opt_out_push'")).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
  });
});

describe('checkout consent is scoped (review fix 1)', () => {
  it('records nothing on the shared number', async () => {
    const ws = W(10);
    await storeWorkspace(ws);
    const out = await workspace(ws).applyStoreEvent(abandoned(ws, 'c1') as never, { phoneNumberId: 'pn-x', shared: true });
    expect(out.status).toBe('skipped');
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
  });

  it('gets the cart reminder but is not in a campaign audience until the buyer writes first', async () => {
    const ws = W(11);
    await storeWorkspace(ws);
    await deliver([abandoned(ws, 'c1')]);
    expect((await flush(ws)).map((j) => j.idempotencyKey)).toContain('cart:c1');
    const everyone = segmentCriteria.parse({ everyone: true });
    expect(await workspace(ws).audiencePage(everyone, 0, 10)).toEqual([]);
    expect((await workspace(ws).previewAudience(everyone)).count).toBe(0);
    await say(ws, 'hello', 1);
    expect((await workspace(ws).audiencePage(everyone, 0, 10)).map((r) => r.waId)).toEqual([WA_1]);
    expect((await workspace(ws).previewAudience(everyone)).count).toBe(1);
  });
});

describe('withdrawal is remembered per buyer (review fix 2)', () => {
  const revokedRows = (ws: string) => rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'revoked:%'");
  it('a withdrawal for an unknown buyer blocks an older or equal attestation, a newer one grants', async () => {
    const ws = W(12);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([changed(ws, false, iso(t))]);
    expect(await revokedRows(ws)).toHaveLength(1);
    await deliver([abandoned(ws, 'old', iso(t - 1000))]);
    await deliver([abandoned(ws, 'tie', iso(t))]);
    expect((await consent(ws))[0]?.consent_at ?? null).toBeNull();
    expect((await flush(ws)).map((j) => j.idempotencyKey)).not.toContain('cart:old');
    await deliver([abandoned(ws, 'new', iso(t + 1))]);
    expect(await consent(ws)).toMatchObject([{ consent_source: 'store_checkout', consent_at: t + 1 }]);
  });

  it('a consent_changed true that is not strictly newer than the withdrawal is ignored', async () => {
    const ws = W(13);
    await storeWorkspace(ws);
    const t = Date.now();
    await deliver([changed(ws, false, iso(t))]);
    await say(ws, 'hello', 1);
    await keyed(ws);
    await deliver([changed(ws, true, iso(t))]);
    expect((await consent(ws))[0]?.consent_at ?? null).toBeNull();
  });

  it('erasure clears the withdrawal record', async () => {
    const ws = W(14);
    await storeWorkspace(ws);
    await deliver([changed(ws, false)]);
    expect(await revokedRows(ws)).toHaveLength(1);
    await deliver([storeEvent(ws, 'customer.erased', { buyerKey: BUYER_KEY_1 })]);
    expect(await revokedRows(ws)).toEqual([]);
  });
});
