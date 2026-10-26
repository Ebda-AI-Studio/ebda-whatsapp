import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { useStoreLink } from './helpers/store-link';
import { seedNumber, workspace } from './helpers/workspace';
import { exec, openChat, own } from './helpers/workspace';
import { seedTemplate } from './helpers/campaigns';

useApiKey();
const link = useStoreLink();
const DAY = 86_400_000;
beforeEach(async () => {
  configureSessionCheck(async () => false);
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, created_at) VALUES ('gold', 'Gold', 50000, 300, 1)").run();
});
afterEach(() => configureSessionCheck(null));
const body = (o: Record<string, unknown> = {}) => ({ packageId: 'gold', status: 'active', periodEnd: Date.now() + 30 * DAY, reason: 'sales deal 42', ...o });
const put = (ws: string, b: unknown) => operatorCall(OP1, 'PUT', `/workspaces/${ws}/subscription`, b);

describe('PUT /operator/workspaces/:id/subscription', () => {
  it('is for super admins only: no token 401, a store owner 403', async () => {
    const ws = W(8301);
    const owner = await apiFor(ws);
    expect((await operatorCall(null, 'PUT', `/workspaces/${ws}/subscription`, body())).status).toBe(401);
    const { SELF } = await import('cloudflare:test');
    const r = await SELF.fetch(`https://x/api/v1/operator/workspaces/${ws}/subscription`, { method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    expect(r.status).toBe(403);
    const staff = await apiFor(ws, 'staff');
    const r2 = await SELF.fetch(`https://x/api/v1/operator/workspaces/${ws}/subscription`, { method: 'PUT', headers: { authorization: `Bearer ${staff.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body()) });
    expect(r2.status).toBe(403);
    expect(await env.DB.prepare('SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first()).toBeNull();
  });

  it('a revoked session is refused and nothing is written; an unavailable accounts service refuses (503)', async () => {
    const ws = W(8302);
    await seedNumber('pn-po-2', ws);
    configureSessionCheck(async () => true);
    expect((await put(ws, body())).status).toBe(403);
    configureSessionCheck(async () => { throw new Error('down'); });
    expect((await put(ws, body())).status).toBe(503);
    expect(await env.DB.prepare('SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ?').bind(ws).first()).toBeNull();
  });

  it('404 for an unknown workspace or package; 400 for a bad body', async () => {
    const ws = W(8303);
    await seedNumber('pn-po-3', ws);
    expect((await put(W(8399), body())).status).toBe(404);
    expect((await put(ws, body({ packageId: 'nope' }))).status).toBe(404);
    expect((await put(ws, body({ status: 'weird' }))).status).toBe(400);
    expect((await put(ws, body({ reason: 'x' }))).status).toBe(400);
  });

  it('success writes source operator with an audit row, pushes at once and tells the Store; a marketing send is then not plan_blocked', async () => {
    const ws = W(8304);
    await seedTemplate(ws, { name: 'promo', category: 'MARKETING' });
    await own(ws);
    const conv = await openChat(ws);
    await exec(ws, 'DELETE FROM entitlements'); // no plan on record: every send is refused (fail closed)
    const tmpl = { type: 'template' as const, clientId: '00000000-0000-4000-8000-00000000a0c1', name: 'promo', language: 'ar', params: ['a', 'b'] };
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', tmpl)).toMatchObject({ ok: false, reason: 'plan_required' });
    const r = await put(ws, body());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ packageId: 'gold', status: 'active', version: 1 });
    expect(await workspace(ws).getEntitlement()).toMatchObject({ packageId: 'gold', version: 1, aiCredits: 300 });
    expect(await workspace(ws).queueOutbound(conv, 'pn-x', { ...tmpl, clientId: '00000000-0000-4000-8000-00000000a0c2' })).toMatchObject({ ok: true });
    expect(await env.DB.prepare("SELECT actor, reason, after_json FROM billing_audit WHERE workspace_id = ? AND action = 'subscription_set'").bind(ws).first()).toMatchObject({ actor: 'operator', reason: OP1 });
    expect(link.sink.sent.at(-1)).toMatchObject({ type: 'whatsapp.entitlement_changed', storeId: ws, data: { packageId: 'gold', version: 1 } });
  });
});
