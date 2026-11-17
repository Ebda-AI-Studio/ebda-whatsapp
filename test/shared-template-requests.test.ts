import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { adminToken, apiFor, graphStub, storeId as W, tokenFor, useApiKey } from './helpers/api';
import type { stubGraph } from './helpers/graph';

// Plan 2 task 12 (A18): a store on the SHARED number lists the platform's sendable utility/authentication templates, asks for a new one, and learns why
// marketing needs its own number. WA-SHARED-NOCAMP-1 stands: marketing is never sendable from the shared number, and never requestable here.
useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());
const PLAT = '5550002';
const WABA = '4440002';
const ON = { SHARED_NUMBER_ENABLED: 'true', META_SYSTEM_TOKEN: 'platform-token-shared-requests', ACCOUNTS: { isRevoked: async () => false } };
const fetchWith = (over: Record<string, unknown> = {}) => (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), { ...env, ...ON, ...over } as typeof env, createExecutionContext());

async function member(n: number, role: 'owner' | 'staff' = 'owner') {
  const id = W(n);
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(id, id, Date.now()).run();
  await env.DB.prepare("INSERT OR REPLACE INTO shared_number_members (workspace_id, phone_number_id, display_name, status, joined_at) VALUES (?, ?, ?, 'active', 1)").bind(id, PLAT, `متجر ${n}`).run();
  const token = await tokenFor(id, 600, role);
  const call = (method: string, path: string, body?: unknown) => fetchWith()(`https://x/api/v1/stores/${id}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { id, call };
}
const operator = async (path: string) => fetchWith()(`https://x/api/v1/operator/shared-template-requests${path}`, { headers: { authorization: `Bearer ${await adminToken()}` } });
const platformTpl = (name: string, category: string, status = 'APPROVED') =>
  env.DB.prepare("INSERT OR REPLACE INTO shared_templates (waba_id, name, language, category, status, components, rejected_reason, updated_at) VALUES (?, ?, 'ar', ?, ?, ?, NULL, 1)")
    .bind(WABA, name, category, status, JSON.stringify([{ type: 'BODY', text: `أهلاً {{1}} ${name}` }]));
const REQ = { name: 'order_ready', language: 'ar', category: 'UTILITY', body: 'أهلاً {{1}}، طلبك رقم {{2}} جاهز للاستلام من المتجر.' };

beforeEach(async () => {
  graph = graphStub((c) => (c.url.endsWith('/message_templates') && c.method === 'POST' ? { status: 200, json: { id: 'p-1', status: 'PENDING', category: 'UTILITY' } } : { status: 200, json: { data: [] } }));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_template_requests'), env.DB.prepare('DELETE FROM shared_templates'), env.DB.prepare('DELETE FROM shared_number_members'), env.DB.prepare('DELETE FROM shared_numbers'),
    env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, ?, '+20 100 555 0002', 1)").bind(PLAT, WABA),
    env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 1)").bind(PLAT),
    platformTpl('util_ok', 'UTILITY'), platformTpl('auth_ok', 'AUTHENTICATION'), platformTpl('promo_no', 'MARKETING'), platformTpl('util_pending', 'UTILITY', 'PENDING'), platformTpl('util_rejected', 'UTILITY', 'REJECTED'),
  ]);
});

describe('GET /templates/shared', () => {
  it('a shared member lists only APPROVED UTILITY/AUTHENTICATION platform templates: name, body, paramCount, no marketing, no status internals', async () => {
    const m = await member(2200);
    const res = await m.call('GET', '/templates/shared');
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((x) => x.name)).toEqual(['auth_ok', 'util_ok']);
    expect(items[1]).toEqual({ name: 'util_ok', language: 'ar', category: 'UTILITY', bodyText: 'أهلاً {{1}} util_ok', paramCount: 1 });
  });
  it('a store that is not a member gets 404', async () => {
    await apiFor(W(2201));
    await env.DB.prepare('DELETE FROM phone_numbers WHERE workspace_id = ?').bind(W(2201)).run();
    const token = await tokenFor(W(2201), 600);
    const res = await fetchWith()(`https://x/api/v1/stores/${W(2201)}/templates/shared`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(404);
  });
  it('a store with its OWN number gets 404 even if it is also a member row (the own number wins)', async () => {
    const own = await apiFor(W(2202));
    await env.DB.prepare("INSERT OR REPLACE INTO shared_number_members (workspace_id, phone_number_id, display_name, status, joined_at) VALUES (?, ?, 'x', 'active', 1)").bind(W(2202), PLAT).run();
    const res = await fetchWith()(`https://x/api/v1/stores/${W(2202)}/templates/shared`, { headers: { authorization: `Bearer ${own.token}` } });
    expect(res.status).toBe(404);
  });
  it('the switch off is 404', async () => {
    const m = await member(2203);
    const res = await fetchWith({ SHARED_NUMBER_ENABLED: undefined })(`https://x/api/v1/stores/${m.id}/templates/shared`, { headers: { authorization: `Bearer ${await tokenFor(m.id, 600)}` } });
    expect(res.status).toBe(404);
  });
});

describe('requests', () => {
  it('an owner asks for a utility template: 201, stored as open, and it shows in their own list', async () => {
    const m = await member(2210);
    const res = await m.call('POST', '/templates/shared-requests', REQ);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: 'order_ready', category: 'UTILITY', status: 'open' });
    const list = ((await (await m.call('GET', '/templates/shared-requests')).json()) as { items: { name: string; status: string }[] }).items;
    expect(list).toMatchObject([{ name: 'order_ready', status: 'open' }]);
  });
  it('MARKETING is refused with marketing_not_on_shared_number and nothing is stored', async () => {
    const m = await member(2211);
    const res = await m.call('POST', '/templates/shared-requests', { ...REQ, category: 'MARKETING' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'marketing_not_on_shared_number' });
    expect((await env.DB.prepare('SELECT count(*) AS n FROM shared_template_requests').first<{ n: number }>())!.n).toBe(0);
  });
  it('the 6th open request is refused (429-style rate_limited); a done one frees a slot', async () => {
    const m = await member(2212);
    for (let i = 0; i < 5; i++) expect((await m.call('POST', '/templates/shared-requests', { ...REQ, name: `req_${i}` })).status).toBe(201);
    const sixth = await m.call('POST', '/templates/shared-requests', { ...REQ, name: 'req_6' });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ error: 'rate_limited', message: 'too_many_open_requests' });
    await env.DB.prepare("UPDATE shared_template_requests SET status = 'done' WHERE name = 'req_0'").run();
    expect((await m.call('POST', '/templates/shared-requests', { ...REQ, name: 'req_6' })).status).toBe(201);
  });
  it('invalid name, empty body and a non-member are refused; staff may list but not request', async () => {
    const m = await member(2213);
    expect((await m.call('POST', '/templates/shared-requests', { ...REQ, name: 'Bad Name' })).status).toBe(400);
    expect((await m.call('POST', '/templates/shared-requests', { ...REQ, body: '   ' })).status).toBe(400);
    const staff = await member(2214, 'staff');
    expect((await staff.call('POST', '/templates/shared-requests', REQ)).status).toBe(403);
    expect((await staff.call('GET', '/templates/shared-requests')).status).toBe(200);
    expect((await staff.call('GET', '/templates/shared')).status).toBe(200);
  });
  it('requests are per workspace: another store never sees them', async () => {
    const a = await member(2215);
    const b = await member(2216);
    await a.call('POST', '/templates/shared-requests', REQ);
    expect(((await (await b.call('GET', '/templates/shared-requests')).json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('operator', () => {
  it('the operator list shows requests with the workspace id; submitting the template marks the matching request done', async () => {
    const m = await member(2220);
    await m.call('POST', '/templates/shared-requests', REQ);
    const list = ((await (await operator('')).json()) as { items: { workspaceId: string; name: string; status: string; body: string }[] }).items;
    expect(list).toMatchObject([{ workspaceId: m.id, name: 'order_ready', status: 'open', body: REQ.body }]);
    const submit = await fetchWith()('https://x/api/v1/operator/shared-templates', {
      method: 'POST', headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'order_ready', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: REQ.body }] }),
    });
    expect(submit.status).toBe(201);
    expect(((await (await m.call('GET', '/templates/shared-requests')).json()) as { items: { status: string }[] }).items[0]!.status).toBe('done');
  });
  it('a store owner cannot read the operator list', async () => {
    const m = await member(2221);
    const res = await fetchWith()('https://x/api/v1/operator/shared-template-requests', { headers: { authorization: `Bearer ${await tokenFor(m.id, 600)}` } });
    expect(res.status).toBe(403);
  });
});
