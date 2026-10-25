import { expect, it } from 'vitest';
import { outboundStoreEventSchema, parseStoreEvent } from '../src/core/api/store-events';

const base = { id: '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', v: 1, storeId: 's1', occurredAt: '2026-10-25T10:00:00+02:00' };
const plan = { planCode: 'business', includesWhatsApp: true, ownerUserId: 'u1', effectiveAt: '2026-10-25T10:00:00+02:00' };

it('store.plan_changed may carry the plan status and period end; a Store that sends neither stays valid', () => {
  const full = parseStoreEvent({ ...base, type: 'store.plan_changed', data: { ...plan, status: 'past_due', periodEnd: '2026-11-25T10:00:00+02:00' } });
  expect(full.ok && full.event.type === 'store.plan_changed' && full.event.data.status).toBe('past_due');
  expect(parseStoreEvent({ ...base, type: 'store.plan_changed', data: plan }).ok).toBe(true);
  expect(parseStoreEvent({ ...base, type: 'store.plan_changed', data: { ...plan, status: 'paused' } })).toEqual({ ok: false, reason: 'invalid' });
});

it('whatsapp.entitlement_changed tells the Store which package a store holds and whether automation is on', () => {
  const ev = { ...base, type: 'whatsapp.entitlement_changed', data: { packageId: 'wa-growth', automation: true, status: 'active', validUntil: '2026-11-25T10:00:00+02:00', version: 3 } };
  expect(outboundStoreEventSchema.safeParse(ev).success).toBe(true);
  expect(outboundStoreEventSchema.safeParse({ ...ev, data: { ...ev.data, version: 0 } }).success).toBe(false);
  expect(outboundStoreEventSchema.safeParse({ ...ev, data: { ...ev.data, status: 'paused' } }).success).toBe(false);
});
