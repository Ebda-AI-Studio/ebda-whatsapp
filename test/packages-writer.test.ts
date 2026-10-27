import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { setSubscription } from '../src/core/billing/subscriptions';
import { useStoreLink } from './helpers/store-link';
import { rows, seedNumber, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000081${String(n).padStart(2, '0')}`;
const DAY = 86_400_000;
const link = useStoreLink();
const base = (ws: string, o: Record<string, unknown> = {}) => ({ workspaceId: ws, packageId: 'store-included', status: 'active' as const, periodStart: Date.now() - DAY, periodEnd: Date.now() + 30 * DAY, source: 'operator' as const, ref: 'op-1', ...o });

describe('setSubscription: the one writer', () => {
  it('bumps the version strictly, pushes the workspace at once and audits each write', async () => {
    const ws = W(1);
    await seedNumber('pn-pk-1', ws);
    const a = await setSubscription(env, base(ws));
    const b = await setSubscription(env, base(ws, { status: 'past_due' }));
    expect([a.version, b.version]).toEqual([1, 2]);
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 2, packageId: 'store-included', status: 'past_due' });
    const audit = await env.DB.prepare("SELECT actor, action, ref FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set' ORDER BY id").bind(ws).all();
    expect(audit.results).toEqual([{ actor: 'operator', action: 'subscription_set', ref: 'op-1' }, { actor: 'operator', action: 'subscription_set', ref: 'op-1' }]);
    expect((await env.DB.prepare('SELECT source FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first<{ source: string }>())?.source).toBe('operator');
  });

  it('queues whatsapp.entitlement_changed carrying the new version, status and validUntil', async () => {
    const ws = W(2);
    await seedNumber('pn-pk-2', ws);
    const end = Date.now() + 30 * DAY;
    const r = await setSubscription(env, base(ws, { periodEnd: end }));
    expect(link.sink.sent).toHaveLength(1);
    expect(link.sink.sent[0]).toMatchObject({ type: 'whatsapp.entitlement_changed', storeId: ws, data: { packageId: 'store-included', automation: true, status: 'active', validUntil: new Date(end).toISOString(), version: r.version } });
    await setSubscription(env, base(ws, { status: 'cancelled' }));
    expect(link.sink.sent[1]).toMatchObject({ data: { automation: false, status: 'cancelled', version: r.version + 1 } });
    expect(link.sink.sent[1]!.id).not.toBe(link.sink.sent[0]!.id);
  });

  it('a queue outage does not undo the write: the row and the workspace are updated, the failure is returned', async () => {
    const ws = W(3);
    await seedNumber('pn-pk-3', ws);
    link.sink.failNext = 1;
    const r = await setSubscription(env, base(ws));
    expect(r).toMatchObject({ version: 1, applied: true, eventQueued: false });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ version: 1 });
  });

  it('two concurrent writers never share a version', async () => {
    const ws = W(4);
    await seedNumber('pn-pk-4', ws);
    const rs = await Promise.all([setSubscription(env, base(ws)), setSubscription(env, base(ws, { source: 'purchase', ref: 'o' }))]);
    expect(rs.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(await rows(ws, 'SELECT version FROM entitlements')).toEqual([{ version: 2 }]);
  });
});
