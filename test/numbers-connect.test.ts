import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import worker from '../src/index';
import { decryptSecret } from '../src/core/ai/secrets';
import { listNumbersResponse, numberDto } from '../src/core/api/contract';
import { generatePin } from '../src/core/numbers/numbers';
import { clearTokenCaches, graphTokenFor, TokenUnavailable } from '../src/core/numbers/token';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { GraphCall, GraphReply, stubGraph } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';
import { exec, rows, seedNumber } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(clearTokenCaches);
afterEach(() => graph?.restore());

const phoneOf = (id: string, extra: Record<string, unknown> = {}) => ({
  id, display_phone_number: '+20 100 000 1111', verified_name: 'Demo Shop', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250',
  throughput: { level: 'STANDARD' }, name_status: 'APPROVED', platform_type: 'CLOUD_API', is_on_biz_app: false, ...extra,
});

/** A Graph that behaves like Meta for the signup calls; `over` replaces the answer for one "METHOD suffix" key. */
function meta(waba: string, pn: string, over: Record<string, GraphReply | ((c: GraphCall) => GraphReply)> = {}) {
  return (c: GraphCall): GraphReply => {
    const path = new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '');
    const key = `${c.method} ${path.replace(waba, 'WABA').replace(pn, 'PN')}`;
    const hit = over[key];
    if (hit) return typeof hit === 'function' ? hit(c) : hit;
    switch (key) {
      case 'GET oauth/access_token': return { status: 200, json: { access_token: 'biz-token-new', token_type: 'bearer' } };
      case 'GET WABA/phone_numbers': return { status: 200, json: { data: [phoneOf(pn)] } };
      case 'POST WABA/subscribed_apps':
      case 'DELETE WABA/subscribed_apps':
      case 'POST PN/register':
      case 'POST PN/deregister': return { status: 200, json: { success: true } };
      case 'POST PN/smb_app_data': return { status: 200, json: { messaging_product: 'whatsapp', request_id: 'req-1' } };
      case 'GET PN': return { status: 200, json: phoneOf(pn) };
      default: return { status: 404, json: { error: { code: 100, message: `unstubbed ${key}` } } };
    }
  };
}
const paths = () => graph!.calls.map((c) => `${c.method} ${new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '')}`);
const row = async (pn: string) => (await env.DB.prepare('SELECT * FROM phone_numbers WHERE phone_number_id = ?').bind(pn).first<Record<string, any>>())!;

const connect = (api: Awaited<ReturnType<typeof apiFor>>, waba: string, pn: string, event = 'FINISH', code = 'code-1') =>
  api.call('POST', '/numbers/connect', { code, event, wabaId: waba, phoneNumberId: pn });

it('is off (404) without the switch, and a missing secret is a clear 503 that calls Meta for nothing', async () => {
  const api = await apiFor(W(500));
  graph = graphStub(meta('9001', '8001'));
  const call = (e: Record<string, unknown>) => worker.fetch(new Request(`https://x/api/v1/stores/${W(500)}/numbers`, { headers: { authorization: `Bearer ${api.token}` } }), { ...env, ...e } as typeof env, createExecutionContext());
  expect((await call({ EMBEDDED_SIGNUP_ENABLED: '0' })).status).toBe(404);
  expect((await call({ EMBEDDED_SIGNUP_ENABLED: undefined })).status).toBe(404);
  expect((await call({})).status).toBe(200);
  const post = await worker.fetch(new Request(`https://x/api/v1/stores/${W(500)}/numbers/connect`, {
    method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'c', event: 'FINISH', wabaId: '9001', phoneNumberId: '8001' }),
  }), { ...env, TOKEN_ENC_KEY: undefined } as typeof env, createExecutionContext());
  expect(post.status).toBe(503);
  expect(await post.json()).toEqual({ error: 'signup_unavailable', message: 'signup_not_configured' });
  expect(graph.calls).toHaveLength(0);
});

it('FINISH: exchanges the code first, verifies, subscribes, registers with a stored 6-digit PIN and goes active', async () => {
  const api = await apiFor(W(501));
  graph = graphStub(meta('9101', '8101'));
  const res = await connect(api, '9101', '8101');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { number: unknown; warnings: string[] };
  const dto = numberDto.parse(body.number);
  expect(dto).toMatchObject({ phoneNumberId: '8101', wabaId: '9101', kind: 'own', onboarding: 'cloud_api', status: 'active', registration: 'registered', verifiedName: 'Demo Shop', qualityRating: 'GREEN', messagingLimitTier: 'TIER_250', throughputLevel: 'STANDARD', syncDeadlineAt: null });
  expect(paths()[0]).toBe('GET oauth/access_token');
  expect(paths()).toEqual(['GET oauth/access_token', 'GET 9101/phone_numbers', 'POST 9101/subscribed_apps', 'POST 8101/register', 'GET 8101']);
  const q = new URL(graph.calls[0]!.url).searchParams;
  expect([q.get('client_id'), q.get('client_secret'), q.get('code')]).toEqual(['app-1', 'test-secret', 'code-1']);
  expect(graph.calls[2]!.headers.authorization).toBe('Bearer biz-token-new');
  const sentPin = graph.calls[3]!.body.pin as string;
  expect(sentPin).toMatch(/^\d{6}$/);
  expect(graph.calls[3]!.body).toEqual({ messaging_product: 'whatsapp', pin: sentPin });
  // Stored encrypted, bound to the workspace, never in the response.
  const r = await row('8101');
  expect(await decryptSecret(r.pin_enc, env.TOKEN_ENC_KEY!, W(501))).toBe(sentPin);
  expect(await decryptSecret(r.pin_enc, env.TOKEN_ENC_KEY!, W(502))).toBeNull();
  const cred = (await env.DB.prepare('SELECT * FROM waba_credentials WHERE waba_id = ?').bind('9101').first<Record<string, any>>())!;
  expect(cred.token_enc).not.toContain('biz-token-new');
  expect(await decryptSecret(cred.token_enc, env.TOKEN_ENC_KEY!, W(501))).toBe('biz-token-new');
  expect(JSON.stringify(body)).not.toContain('biz-token-new');
  expect(JSON.stringify(body)).not.toContain(sentPin);
  expect(await graphTokenFor(env, { phoneNumberId: '8101' })).toBe('biz-token-new');
});

it('owner only; a body that does not parse is 400', async () => {
  const staff = await apiFor(W(503), 'staff');
  graph = graphStub(meta('9102', '8102'));
  expect((await connect(staff, '9102', '8102')).status).toBe(403);
  const owner = await apiFor(W(504));
  expect((await owner.call('POST', '/numbers/connect', { code: 'c', event: 'FINISH', wabaId: 'x', phoneNumberId: '1' })).status).toBe(400);
  expect((await owner.call('POST', '/numbers/connect', { code: 'c', event: 'NOPE', wabaId: '1', phoneNumberId: '1' })).status).toBe(400);
  expect(graph.calls).toHaveLength(0);
});

it('BUSINESS_APP: no register, both one-time syncs requested once, 20 mps, a refused sync is shown not thrown', async () => {
  const api = await apiFor(W(505));
  graph = graphStub(meta('9103', '8103', {
    'GET WABA/phone_numbers': { status: 200, json: { data: [phoneOf('8103', { is_on_biz_app: true })] } },
    'GET PN': { status: 200, json: phoneOf('8103', { is_on_biz_app: true, throughput: { level: 'NOT_APPLICABLE' } }) },
    'POST PN/smb_app_data': (c) => (c.body.sync_type === 'history' ? { status: 400, json: { error: { code: 100, message: 'no' } } } : { status: 200, json: { request_id: 'r' } }),
  }));
  const res = await connect(api, '9103', '8103', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { number: any; warnings: string[] };
  expect(paths()).toEqual(['GET oauth/access_token', 'GET 9103/phone_numbers', 'POST 9103/subscribed_apps', 'POST 8103/smb_app_data', 'POST 8103/smb_app_data', 'GET 8103']);
  expect(graph.calls.filter((c) => c.url.endsWith('smb_app_data')).map((c) => c.body.sync_type)).toEqual(['smb_app_state_sync', 'history']);
  expect(body.number).toMatchObject({ onboarding: 'business_app', registration: 'not_needed', status: 'active', isOnBizApp: true, contactsSync: 'requested', historySync: 'refused' });
  expect(body.number.syncDeadlineAt).toBe(body.number.connectedAt + 24 * 3600_000);
  expect(body.warnings).toEqual(['history_sync_refused']);
  expect((await row('8103')).pin_enc).toBeNull();
  expect(await rows(W(505), "SELECT mps FROM number_limits WHERE phone_number_id = '8103'")).toEqual([{ mps: 20 }]);
  // Each sync runs once: a second connect (new code) does not ask again.
  graph.calls.length = 0;
  expect((await connect(api, '9103', '8103', 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', 'code-2')).status).toBe(200);
  expect(paths().filter((p) => p.endsWith('smb_app_data'))).toEqual([]);
});

it('a failed webhook subscription is a hard, retryable failure; the number waits disconnected and /register finishes it', async () => {
  const api = await apiFor(W(506));
  let subscribed = 0;
  graph = graphStub(meta('9104', '8104', { 'POST WABA/subscribed_apps': () => (subscribed++ ? { status: 200, json: { success: true } } : { status: 500, json: { error: { code: 2, message: 'down' } } }) }));
  const res = await connect(api, '9104', '8104');
  expect(res.status).toBe(503);
  const err = (await res.json()) as { error: string; number: { status: string; registration: string } };
  expect(err.error).toBe('signup_unavailable');
  expect(err.number).toMatchObject({ status: 'disconnected', registration: 'pending' });
  expect(paths().some((p) => p.endsWith('/register'))).toBe(false);
  const again = await api.call('POST', '/numbers/8104/register');
  expect(again.status).toBe(200);
  expect(((await again.json()) as any).number).toMatchObject({ status: 'active', registration: 'registered' });
});

it('error 133016 is 429 registration_locked and is remembered; a staff member cannot retry', async () => {
  const api = await apiFor(W(507));
  graph = graphStub(meta('9105', '8105', { 'POST PN/register': { status: 400, json: { error: { code: 133016, message: 'locked' } } } }));
  const res = await connect(api, '9105', '8105');
  expect(res.status).toBe(429);
  expect(await res.json()).toMatchObject({ error: 'registration_locked', number: { registration: 'locked', status: 'disconnected' } });
  expect((await row('8105')).registration).toBe('locked');
  const staff = await apiFor(W(507), 'staff');
  expect((await staff.call('POST', '/numbers/8105/register')).status).toBe(403);
});

it('a plain registration failure is kept as failed and retried with the SAME stored PIN', async () => {
  const api = await apiFor(W(508));
  let n = 0;
  graph = graphStub(meta('9106', '8106', { 'POST PN/register': () => (n++ ? { status: 200, json: { success: true } } : { status: 400, json: { error: { code: 131000, message: 'x' } } }) }));
  expect((await connect(api, '9106', '8106')).status).toBe(503); // 131000 is retryable per the shared error table
  expect((await row('8106')).registration).toBe('failed');
  expect((await api.call('POST', '/numbers/8106/register')).status).toBe(200);
  const pins = graph.calls.filter((c) => c.url.endsWith('/register')).map((c) => c.body.pin);
  expect(pins).toHaveLength(2);
  expect(pins[0]).toBe(pins[1]);
});

it('refuses a number or WABA that belongs to another workspace (409) before spending the code', async () => {
  await seedOwnNumber('8107', W(509), '9107');
  const other = await apiFor(W(510));
  graph = graphStub(meta('9107', '8107'));
  const res = await connect(other, '9107', '8107');
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: 'number_conflict' });
  // same WABA, different number
  expect((await connect(other, '9107', '8108')).status).toBe(409);
  expect(graph.calls).toHaveLength(0);
  expect((await row('8107')).workspace_id).toBe(W(509));
});

it('a number released by a disconnect can be connected by another workspace, with a clean slate', async () => {
  await seedOwnNumber('8109', W(511), '9109');
  await env.DB.prepare("UPDATE phone_numbers SET status = 'disconnected', history_sync = 'received' WHERE phone_number_id = '8109'").run();
  await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id = '9109'").run();
  const other = await apiFor(W(512));
  graph = graphStub(meta('9109', '8109'));
  expect((await connect(other, '9109', '8109')).status).toBe(200);
  const r = await row('8109');
  expect([r.workspace_id, r.status, r.history_sync]).toEqual([W(512), 'active', null]);
});

it('rejects a code Meta refuses, and a number that is not in the claimed WABA, storing nothing', async () => {
  const api = await apiFor(W(513));
  graph = graphStub(meta('9110', '8110', { 'GET oauth/access_token': { status: 400, json: { error: { code: 100, error_subcode: 36007, message: 'used' } } } }));
  const a = await connect(api, '9110', '8110');
  expect([a.status, ((await a.json()) as any).error]).toEqual([400, 'signup_failed']);
  graph.restore();
  graph = graphStub(meta('9110', '8110', { 'GET WABA/phone_numbers': { status: 200, json: { data: [phoneOf('7777')] } } }));
  const b = await connect(api, '9110', '8110');
  expect([b.status, ((await b.json()) as any).message]).toEqual([400, 'number_not_in_waba']);
  graph.restore();
  graph = graphStub(meta('9110', '8110', { 'GET WABA/phone_numbers': { status: 403, json: { error: { code: 200, message: 'no access' } } } }));
  expect((await connect(api, '9110', '8110')).status).toBe(400);
  expect(await env.DB.prepare('SELECT 1 FROM waba_credentials WHERE waba_id = ?').bind('9110').first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM phone_numbers WHERE phone_number_id = ?').bind('8110').first()).toBeNull();
});

it('connecting twice is idempotent: one row, registered once, the PIN unchanged', async () => {
  const api = await apiFor(W(514));
  graph = graphStub(meta('9111', '8111'));
  expect((await connect(api, '9111', '8111')).status).toBe(200);
  const pin1 = (await row('8111')).pin_enc;
  expect((await connect(api, '9111', '8111', 'FINISH', 'code-2')).status).toBe(200);
  expect(paths().filter((p) => p.endsWith('/register'))).toHaveLength(1);
  expect((await row('8111')).pin_enc).toBe(pin1);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM phone_numbers WHERE phone_number_id = ?').bind('8111').first<{ n: number }>())!.n).toBe(1);
});

it('lists the workspace numbers without secrets (staff too); refresh updates the status columns', async () => {
  const api = await apiFor(W(515));
  graph = graphStub(meta('9112', '8112'));
  await connect(api, '9112', '8112');
  const staff = await apiFor(W(515), 'staff');
  const text = await (await staff.call('GET', '/numbers')).text();
  expect(text).not.toMatch(/biz-token|pin|token_enc/i);
  const list = listNumbersResponse.parse(JSON.parse(text));
  expect(list.items.map((n) => n.phoneNumberId).sort()).toEqual(['8112', `pn-${W(515)}`].sort());
  expect(list.items.find((n) => n.phoneNumberId === `pn-${W(515)}`)).toMatchObject({ kind: 'platform', onboarding: null });
  graph.restore();
  graph = graphStub(meta('9112', '8112', { 'GET PN': { status: 200, json: phoneOf('8112', { quality_rating: 'YELLOW', messaging_limit_tier: 'TIER_1K' }) } }));
  const r = await staff.call('POST', '/numbers/8112/refresh');
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).number).toMatchObject({ qualityRating: 'YELLOW', messagingLimitTier: 'TIER_1K' });
  expect(graph.calls[0]!.headers.authorization).toBe('Bearer biz-token-new');
  expect(await rows(W(515), "SELECT tier FROM number_limits WHERE phone_number_id = '8112'")).toEqual([{ tier: 1000 }]);
  // another workspace's number is invisible
  expect((await (await apiFor(W(516))).call('POST', '/numbers/8112/refresh')).status).toBe(404);
});

it('disconnect: deregisters, unsubscribes, drops the credential and the cached token', async () => {
  const api = await apiFor(W(517));
  graph = graphStub(meta('9113', '8113'));
  await connect(api, '9113', '8113');
  expect(await graphTokenFor(env, { wabaId: '9113' })).toBe('biz-token-new'); // warm the cache
  graph.calls.length = 0;
  const res = await api.call('POST', '/numbers/8113/disconnect');
  expect(res.status).toBe(200);
  expect(paths()).toEqual(['POST 8113/deregister', 'DELETE 9113/subscribed_apps']);
  expect(graph.calls[0]!.headers.authorization).toBe('Bearer biz-token-new');
  expect(((await res.json()) as any).number).toMatchObject({ status: 'disconnected' });
  expect(await env.DB.prepare('SELECT 1 FROM waba_credentials WHERE waba_id = ?').bind('9113').first()).toBeNull();
  expect((await row('8113')).pin_enc).toBeNull();
  // the cache entry is gone: the WABA has no credential any more, and the own number refuses to borrow the platform token
  expect(await graphTokenFor(env, { wabaId: '9113' })).toBe('test-token');
  await expect(graphTokenFor(env, { phoneNumberId: '8113' })).rejects.toBeInstanceOf(TokenUnavailable);
  expect((await (await apiFor(W(517), 'staff')).call('POST', '/numbers/8113/disconnect')).status).toBe(403);
});

it('disconnect keeps the webhook subscription and credential while another number uses the WABA; Meta errors become warnings', async () => {
  const api = await apiFor(W(518));
  await seedOwnNumber('8114', W(518), '9114');
  await env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, kind, onboarding, registration) VALUES ('8115', '9114', ?, 'active', 'own', 'cloud_api', 'registered')").bind(W(518)).run();
  graph = graphStub(meta('9114', '8114', { 'POST PN/deregister': { status: 500, json: { error: { code: 2, message: 'x' } } } }));
  const res = await api.call('POST', '/numbers/8114/disconnect');
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).warnings).toEqual(['deregister_failed']);
  expect(paths()).toEqual(['POST 8114/deregister']);
  expect(await env.DB.prepare('SELECT 1 FROM waba_credentials WHERE waba_id = ?').bind('9114').first()).not.toBeNull();
  expect((await row('8114')).status).toBe('disconnected');
  // a platform number is never disconnected through this route
  const plat = await api.call('POST', `/numbers/pn-${W(518)}/disconnect`);
  expect(plat.status).toBe(400);
});

it('generatePin always gives six digits', () => {
  const pins = Array.from({ length: 300 }, generatePin);
  expect(pins.every((p) => /^\d{6}$/.test(p))).toBe(true);
  expect(new Set(pins).size).toBeGreaterThan(250);
});

it('gives the owner the public Meta ids the page needs to launch Embedded Signup; staff and a missing config id are refused', async () => {
  const owner = await apiFor(W(530));
  const res = await owner.call('GET', '/numbers/signup-config');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ appId: 'app-1', configId: 'cfg-1', graphVersion: env.META_GRAPH_VERSION });
  const staff = await apiFor(W(530), 'staff');
  expect((await staff.call('GET', '/numbers/signup-config')).status).toBe(403);
  const noCfg = await worker.fetch(new Request(`https://x/api/v1/stores/${W(530)}/numbers/signup-config`, { headers: { authorization: `Bearer ${owner.token}` } }), { ...env, EMBEDDED_SIGNUP_CONFIG_ID: undefined } as typeof env, createExecutionContext());
  expect(noCfg.status).toBe(503);
});

it('/me tells the page whether connecting a number is open', async () => {
  const api = await apiFor(W(531));
  expect(await (await api.call('GET', '/me')).json()).toMatchObject({ capabilities: { numbers: true } });
  const off = await worker.fetch(new Request(`https://x/api/v1/stores/${W(531)}/me`, { headers: { authorization: `Bearer ${api.token}` } }), { ...env, EMBEDDED_SIGNUP_ENABLED: '0' } as typeof env, createExecutionContext());
  expect(await off.json()).toMatchObject({ capabilities: { numbers: false } });
});

it('a connected own number is funded merchant_card (Meta bills the merchant) and usable at once: the workspace copy is refreshed, no 30-minute wait', async () => {
  const api = await apiFor(W(532));
  graph = graphStub(meta('9532', '8532'));
  expect((await connect(api, '9532', '8532')).status).toBe(200);
  expect(await env.DB.prepare('SELECT funding FROM number_funding WHERE phone_number_id = ?').bind('8532').first('funding')).toBe('merchant_card');
  expect(await rows(W(532), "SELECT funding FROM number_funding WHERE phone_number_id = '8532'")).toEqual([{ funding: 'merchant_card' }]);
});
