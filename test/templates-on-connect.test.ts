import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { installStarterOnConnect, registerStarterSet, starterSet } from '../src/core/starter-templates';
import { listTemplatesResponse } from '../src/core/api/contract';
import { clearTokenCaches } from '../src/core/numbers/token';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { GraphCall, GraphReply, stubGraph } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';
import { rows, seedNumber } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(() => { clearTokenCaches(); registerStarterSet(EBDA_DEFAULT_TEMPLATES); });
afterEach(() => { graph?.restore(); vi.restoreAllMocks(); });

const NAMES = EBDA_DEFAULT_TEMPLATES.map((t) => t.name);
const atMeta = (name: string, status = 'APPROVED', language = 'ar') => ({ id: `id-${name}`, name, language, category: 'UTILITY', status, components: [{ type: 'BODY', text: 'أهلاً {{1}} طلبك.' }] });
/** A Meta that lists `have` and accepts every submission. */
const metaWith = (have: string[] = [], over?: (c: GraphCall) => GraphReply | undefined) => (c: GraphCall): GraphReply => {
  const o = over?.(c);
  if (o) return o;
  if (c.url.includes('/message_templates') && c.method === 'GET') return { status: 200, json: { data: [...new Set(have)].flatMap((n) => EBDA_DEFAULT_TEMPLATES.filter((t) => t.name === n).map((t) => atMeta(n, 'APPROVED', t.language))) } };
  if (c.url.includes('/message_templates') && c.method === 'POST') return { status: 200, json: { id: `new-${c.body.name}`, status: 'PENDING', category: c.body.category } };
  return { status: 404, json: { error: { message: 'unstubbed' } } };
};
const posts = () => graph!.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates')).map((c) => c.body.name as string);
const marker = (ws: string, waba: string) => rows(ws, 'SELECT value FROM store_state WHERE key = ?', `templates.starter:${waba}`);

it('registerStarterSet holds the brand starter set per isolate', () => {
  expect(starterSet().map((t) => t.name)).toEqual(NAMES);
});

it('connecting syncs what Meta already has first, adopts it, and submits only the missing starters', async () => {
  const id = W(600);
  await seedOwnNumber('pn-600', id, 'waba-600');
  graph = graphStub(metaWith(['order_confirmation', 'shipping_update']));
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-600' })).toBe('done');
  expect(graph.calls[0]!.method).toBe('GET'); // sync BEFORE any submission
  expect(posts()).toEqual(NAMES.filter((n) => n !== 'order_confirmation' && n !== 'shipping_update'));
  expect(await rows(id, "SELECT name, status, meta_id FROM templates WHERE name IN ('order_confirmation', 'shipping_update') ORDER BY name")).toEqual([
    { name: 'order_confirmation', status: 'APPROVED', meta_id: 'id-order_confirmation' }, { name: 'shipping_update', status: 'APPROVED', meta_id: 'id-shipping_update' },
  ]);
  expect(await marker(id, 'waba-600')).toEqual([{ value: 'done' }]);
});

it('a template already at Meta is adopted, never resubmitted, even when every starter exists', async () => {
  const id = W(601);
  await seedOwnNumber('pn-601', id, 'waba-601');
  graph = graphStub(metaWith(NAMES));
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-601' })).toBe('done');
  expect(posts()).toEqual([]);
  expect((await rows(id, 'SELECT 1 FROM templates')).length).toBe(NAMES.length);
});

it('Graph down during the install: partial, marker NOT set, alert logged, nothing thrown', async () => {
  const id = W(602);
  await seedOwnNumber('pn-602', id, 'waba-602');
  const logs: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { logs.push(a.join(' ')); });
  graph = graphStub(() => ({ status: 503, json: {} }));
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-602' })).toBe('partial');
  expect(await marker(id, 'waba-602')).toEqual([]);
  expect(logs.join('\n')).toContain('"alert":"starter_templates_failed"');
});

it('one starter failing leaves the marker unset; running again submits only what is still missing, no duplicates', async () => {
  const id = W(603);
  await seedOwnNumber('pn-603', id, 'waba-603');
  graph = graphStub(metaWith([], (c) => (c.method === 'POST' && c.body.name === 'otp_code' ? { status: 400, json: { error: { message: 'no' } } } : undefined)));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-603' })).toBe('partial');
  expect(await marker(id, 'waba-603')).toEqual([]);
  graph.restore();
  const have = NAMES.filter((n) => n !== 'otp_code');
  graph = graphStub(metaWith(have));
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-603' })).toBe('done');
  expect(posts()).toEqual(['otp_code']);
  expect(await rows(id, 'SELECT count(*) AS n FROM templates')).toEqual([{ n: NAMES.length }]);
  // a third run (resumeSetup re-enters) does nothing at all
  graph.restore();
  graph = graphStub(metaWith());
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-603' })).toBe('done');
  expect(graph.calls.filter((c) => c.url.includes('/message_templates'))).toEqual([]);
});

it('shared-number workspaces never get starters (the platform WABA is not theirs)', async () => {
  const id = W(604);
  await seedNumber('pn-604', id, 'active', 'waba-plat');
  await env.DB.prepare("INSERT OR IGNORE INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES ('shared-pn', 'waba-plat', '+201000000000', 1)").run();
  graph = graphStub(metaWith());
  expect(await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-plat' })).toBe('skipped');
  expect(graph.calls.filter((c) => c.url.includes('/message_templates'))).toEqual([]);
});

it('with no starter set registered it skips', async () => {
  registerStarterSet([]);
  await seedOwnNumber('pn-605', W(605), 'waba-605');
  graph = graphStub(metaWith());
  expect(await installStarterOnConnect(env, { workspaceId: W(605), wabaId: 'waba-605' })).toBe('skipped');
});

it('GET /templates exposes starterInstalled, false until the marker is set', async () => {
  const id = W(606);
  const api = await apiFor(id);
  const before = listTemplatesResponse.parse(await (await api.call('GET', '/templates')).json());
  expect(before.starterInstalled).toBe(false);
  graph = graphStub(metaWith());
  await installStarterOnConnect(env, { workspaceId: id, wabaId: 'waba-1' });
  expect(listTemplatesResponse.parse(await (await api.call('GET', '/templates')).json()).starterInstalled).toBe(true);
});

it('POST /templates/install-defaults is the retry path and sets the marker when nothing failed', async () => {
  const id = W(607);
  const api = await apiFor(id);
  graph = graphStub(metaWith());
  const res = await api.call('POST', '/templates/install-defaults');
  expect((await res.json() as { failed: string[] }).failed).toEqual([]);
  expect(await marker(id, 'waba-1')).toEqual([{ value: 'done' }]);
});

it('connecting through the API installs the starters in the background and the connect still succeeds', async () => {
  const id = W(608);
  const api = await apiFor(id, 'owner', 'pn-seed-608');
  const meta = (c: GraphCall): GraphReply => {
    const path = new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '');
    if (path === 'oauth/access_token') return { status: 200, json: { access_token: 'biz-token-new' } };
    if (path === '9608/phone_numbers') return { status: 200, json: { data: [{ id: '8608', display_phone_number: '+20 100 000 1111', verified_name: 'Shop', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250', throughput: { level: 'STANDARD' }, name_status: 'APPROVED', platform_type: 'CLOUD_API', is_on_biz_app: false }] } };
    if (path.endsWith('subscribed_apps') || path.endsWith('/register')) return { status: 200, json: { success: true } };
    if (path === '8608') return { status: 200, json: { id: '8608', display_phone_number: '+20 100 000 1111', verified_name: 'Shop', quality_rating: 'GREEN' } };
    return metaWith()(c);
  };
  graph = graphStub(meta);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://x/api/v1/stores/${id}/numbers/connect`, {
    method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'c', event: 'FINISH', wabaId: '9608', phoneNumberId: '8608' }),
  }), env, ctx);
  expect(res.status).toBe(200);
  await vi.waitFor(async () => expect(await marker(id, '9608')).toEqual([{ value: 'done' }]));
  expect(posts()).toEqual(NAMES);
});
