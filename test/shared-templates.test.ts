import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { SendJob } from '../src/core/send-queue';
import { adminToken, apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { setupBilling, fund } from './helpers/billing';
import { exec, rows } from './helpers/workspace';
import { seedTemplate } from './helpers/campaigns';
import { sign } from './helpers/meta';
import { templateCategoryPayload, templateStatusPayload } from './helpers/payload';

// Item e: the platform WABA's templates are platform-owned. Operators (super admins) list / sync / submit them with the PLATFORM token;
// stores sending from the shared number may only use APPROVED UTILITY or AUTHENTICATION templates of that catalog (WA-SHARED-NOCAMP-1).
useApiKey();
let graph: ReturnType<typeof graphStub> | undefined;
afterEach(() => graph?.restore());

const PLAT = '5550001';
const WABA = '4440001';
const PLATFORM_TOKEN = 'platform-token-for-shared-templates';
const ON = { SHARED_NUMBER_ENABLED: 'true', META_SYSTEM_TOKEN: PLATFORM_TOKEN, ACCOUNTS: { isRevoked: async () => false } };
const envWith = (over: Record<string, unknown> = {}) => ({ ...env, ...ON, ...over }) as typeof env;
const fetchWith = (over: Record<string, unknown> = {}) => (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), envWith(over), createExecutionContext());

const metaTpl = (name: string, category = 'UTILITY', status = 'APPROVED', extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, language: 'ar', category, status, components: [{ type: 'BODY', text: `أهلا {{1}} ${name}` }], ...extra,
});

async function op(method: string, path: string, body?: unknown, over: Record<string, unknown> = {}, token?: string | null) {
  const t = token === undefined ? await adminToken() : token;
  return fetchWith(over)(`https://x/api/v1/operator/shared-templates${path}`, {
    method,
    headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const catalog = () => env.DB.prepare('SELECT name, language, category, status FROM shared_templates ORDER BY name, language').all<Record<string, string>>().then((r) => r.results);

beforeEach(async () => {
  graph = graphStub((c) => (c.url.includes('/message_templates') && c.method === 'GET'
    ? { status: 200, json: { data: [metaTpl('tpl_u'), metaTpl('tpl_m', 'MARKETING'), metaTpl('tpl_p', 'UTILITY', 'PENDING')] } }
    : c.url.endsWith('/message_templates') ? { status: 200, json: { id: 'new-1', status: 'PENDING', category: 'UTILITY' } }
    : { status: 200, json: { messages: [{ id: `wamid.t${Math.random()}` }] } }));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_templates'), env.DB.prepare('DELETE FROM shared_routes'), env.DB.prepare('DELETE FROM shared_sent'),
    env.DB.prepare('DELETE FROM shared_number_members'), env.DB.prepare('DELETE FROM shared_numbers'),
    env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, ?, '+20 100 555 0001', 1)").bind(PLAT, WABA),
    env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 1)").bind(PLAT),
  ]);
});

describe('who may manage the platform templates', () => {
  it('no token 401; a store owner and a staff member 403; a super admin 200', async () => {
    expect((await op('GET', '', undefined, {}, null)).status).toBe(401);
    for (const role of ['owner', 'staff'] as const) {
      const s = await apiFor(W(2100 + (role === 'owner' ? 0 : 1)), role);
      expect((await op('GET', '', undefined, {}, s.token)).status, role).toBe(403);
      expect((await op('POST', '/sync', {}, {}, s.token)).status, role).toBe(403);
      expect((await op('POST', '', { name: 'x_y', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] }, {}, s.token)).status, role).toBe(403);
    }
    expect((await op('GET', '')).status).toBe(200);
  });
  it('switch off = 404 on every route; switch on but no platform number registered = 404', async () => {
    const off = { SHARED_NUMBER_ENABLED: undefined };
    expect((await op('GET', '', undefined, off)).status).toBe(404);
    expect((await op('POST', '/sync', {}, off)).status).toBe(404);
    await env.DB.prepare('DELETE FROM shared_numbers').run();
    expect((await op('GET', '')).status).toBe(404);
    expect((await op('POST', '/sync', {})).status).toBe(404);
  });
  it('a revoked session cannot sync or submit (403), an unreachable accounts service fails closed (503); reading still works', async () => {
    const body = { name: 'x_y', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'hi' }] };
    const revoked = { ACCOUNTS: { isRevoked: async () => true } };
    expect(await (await op('POST', '/sync', {}, revoked)).json()).toMatchObject({ error: 'forbidden', message: 'session_revoked' });
    expect((await op('POST', '', body, revoked)).status).toBe(403);
    const down = { ACCOUNTS: { isRevoked: async () => { throw new Error('down'); } } };
    expect((await op('POST', '/sync', {}, down)).status).toBe(503);
    expect((await op('POST', '', body, down)).status).toBe(503);
    expect((await op('GET', '', undefined, revoked)).status).toBe(200);
    expect(graph!.calls.filter((c) => c.url.includes('/message_templates'))).toHaveLength(0);
  });
});

describe('sync, list and submit use the platform token on the platform WABA', () => {
  it('sync fetches the shared WABA with the platform token, replaces the catalog, and drops what Meta no longer has', async () => {
    await env.DB.prepare("INSERT INTO shared_templates (waba_id, name, language, category, status, components, rejected_reason, updated_at) VALUES (?, 'gone', 'ar', 'UTILITY', 'APPROVED', '[]', NULL, 1)").bind(WABA).run();
    const r = await op('POST', '/sync', {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ upserted: 3, removed: 1 });
    const call = graph!.calls.find((c) => c.url.includes('/message_templates'))!;
    expect(call.url).toContain(`/${WABA}/message_templates`);
    expect(call.headers.authorization).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(await catalog()).toEqual([
      { name: 'gone', language: 'ar', category: 'UTILITY', status: 'DISABLED' }, // not listed by Meta any more: never sendable (kept, not deleted)
      { name: 'tpl_m', language: 'ar', category: 'MARKETING', status: 'APPROVED' },
      { name: 'tpl_p', language: 'ar', category: 'UTILITY', status: 'PENDING' },
      { name: 'tpl_u', language: 'ar', category: 'UTILITY', status: 'APPROVED' },
    ]);
    const list = (await (await op('GET', '')).json()) as { items: { name: string; paramCount: number; bodyText: string }[] };
    expect(list.items.map((t) => t.name)).toEqual(['gone', 'tpl_m', 'tpl_p', 'tpl_u']);
    expect(list.items[3]).toMatchObject({ paramCount: 1, bodyText: 'أهلا {{1}} tpl_u' });
  });
  it('a merchant\'s own credential is never used: the token is the platform token even when stores have their own WABA tokens', async () => {
    await apiFor(W(2110));
    await env.DB.prepare("INSERT INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at) VALUES ('merchant-waba', ?, 'enc', 'own', 1, 1)").bind(W(2110)).run();
    await op('POST', '/sync', {});
    expect(new Set(graph!.calls.map((c) => c.headers.authorization))).toEqual(new Set([`Bearer ${PLATFORM_TOKEN}`]));
  });
  it('a failed Meta call changes nothing (a sync never half-applies) and answers 503', async () => {
    await op('POST', '/sync', {});
    graph!.restore();
    graph = graphStub(() => ({ status: 500, json: { error: { message: 'boom' } } }));
    const r = await op('POST', '/sync', {});
    expect(r.status).toBe(503);
    expect(await catalog()).toHaveLength(3);
  });
  it('no platform token configured: 503 and no call', async () => {
    const r = await op('POST', '/sync', {}, { META_SYSTEM_TOKEN: '' });
    expect(r.status).toBe(503);
    expect(graph!.calls).toHaveLength(0);
  });
  it('submit posts to the platform WABA with the platform token and records the status; marketing is refused before Meta', async () => {
    const body = { name: 'order_ready', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'طلبك {{1}} جاهز' }] };
    const r = await op('POST', '', body);
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ name: 'order_ready', language: 'ar', status: 'PENDING' });
    const call = graph!.calls.find((c) => c.method === 'POST')!;
    expect(call.url).toContain(`/${WABA}/message_templates`);
    expect(call.headers.authorization).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect(await catalog()).toEqual([{ name: 'order_ready', language: 'ar', category: 'UTILITY', status: 'PENDING' }]);
    const before = graph!.calls.length;
    expect((await op('POST', '', { ...body, name: 'promo', category: 'MARKETING' })).status).toBe(400);
    expect((await op('POST', '', { name: 'Bad Name', language: 'ar', category: 'UTILITY', components: [] })).status).toBe(400);
    expect(graph!.calls.length).toBe(before);
  });
});

describe('what a store may send from the shared number', () => {
  let n = 2200;
  /** A member store with a funded wallet. Its OWN templates table says UTILITY for everything: the platform catalog decides. */
  async function member() {
    const ws = W(++n);
    await setupBilling(W(n + 500));
    await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, `store ${n}`).run();
    const api = await apiFor(ws);
    await env.DB.prepare('DELETE FROM phone_numbers WHERE workspace_id = ?').bind(ws).run(); // shared-only store
    await fund(ws, 100_000);
    for (const t of ['tpl_u', 'tpl_m', 'tpl_p', 'tpl_other']) await seedTemplate(ws, { name: t, category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi {{1}}' }]) });
    await seedTemplate(ws, { name: 'tpl_a', category: 'AUTHENTICATION', components: JSON.stringify([{ type: 'BODY', text: 'code {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] }]) });
    return { ws, api };
  }
  async function join(api: Awaited<ReturnType<typeof member>>['api'], ws: string) {
    const r = await fetchWith()(`https://x/api/v1/stores/${ws}/shared-number/join`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ displayName: `Shop ${ws.slice(-4)}` }) });
    expect(r.status).toBe(200);
  }
  async function send(ws: string, name: string, params: string[] = []) {
    await exec(ws, 'INSERT OR IGNORE INTO contacts (wa_id, profile_name) VALUES (?, ?)', '201001234567', 'c');
    await exec(ws, 'INSERT OR IGNORE INTO conversations (contact_id, last_message_at) SELECT id, 1 FROM contacts WHERE wa_id = ?', '201001234567');
    const conv = (await rows<{ id: number }>(ws, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', '201001234567'))[0]!.id;
    const stub = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
    const r = await stub.queueOutbound(conv, PLAT, { type: 'template', clientId: crypto.randomUUID(), name, language: 'ar', params });
    if (!r.ok || !r.job) throw new Error(`not queued: ${JSON.stringify(r)}`);
    const job: SendJob = r.job;
    const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: job }]);
    const ctx = createExecutionContext();
    const before = graph!.calls.filter((c) => c.url.endsWith('/messages')).length;
    await worker.queue(batch, envWith(), ctx);
    await getQueueResult(batch, ctx);
    const status = (await rows<{ status: string }>(ws, 'SELECT status FROM messages WHERE idempotency_key = ?', job.idempotencyKey))[0]!.status;
    return { status, sent: graph!.calls.filter((c) => c.url.endsWith('/messages')).length - before };
  }

  beforeEach(async () => { await op('POST', '/sync', {}); await op('POST', '', { name: 'tpl_a', language: 'ar', category: 'AUTHENTICATION', components: [{ type: 'BODY', text: 'code {{1}}' }] }); await env.DB.prepare("UPDATE shared_templates SET status = 'APPROVED' WHERE name = 'tpl_a'").run(); });

  it('an APPROVED UTILITY template of the platform catalog goes out; so does an APPROVED AUTHENTICATION one', async () => {
    const { ws, api } = await member(); await join(api, ws);
    expect(await send(ws, 'tpl_u', ['x'])).toEqual({ status: 'accepted', sent: 1 });
    expect(await send(ws, 'tpl_a', ['123456'])).toEqual({ status: 'accepted', sent: 1 });
  });
  it('a pause event for the platform WABA blocks the real send, with a second shared number on the same WABA', async () => {
    await env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES ('5550002', ?, '+20 100 555 0002', 2)").bind(WABA).run();
    const { ws, api } = await member(); await join(api, ws);
    expect(await send(ws, 'tpl_u', ['x'])).toEqual({ status: 'accepted', sent: 1 });
    const raw = templateStatusPayload(WABA, { event: 'PAUSED', name: 'tpl_u', language: 'ar' });
    await fetchWith()('https://x/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': await sign(raw) }, body: raw });
    expect(await send(ws, 'tpl_u', ['x'])).toEqual({ status: 'failed', sent: 0 });
  });
  it('a MARKETING template is refused on the shared number (WA-SHARED-NOCAMP-1): failed, and nothing reaches Meta', async () => {
    const { ws, api } = await member(); await join(api, ws);
    expect(await send(ws, 'tpl_m', ['x'])).toEqual({ status: 'failed', sent: 0 });
  });
  it('a template that is not approved, or not in the platform catalog at all (even if the store\'s own copy says UTILITY), is refused', async () => {
    const { ws, api } = await member(); await join(api, ws);
    expect(await send(ws, 'tpl_p', ['x'])).toEqual({ status: 'failed', sent: 0 });
    expect(await send(ws, 'tpl_other', ['x'])).toEqual({ status: 'failed', sent: 0 });
  });
  it('a category change at Meta is honoured at the next sync: a UTILITY template that became MARKETING stops going out', async () => {
    const { ws, api } = await member(); await join(api, ws);
    await env.DB.prepare("UPDATE shared_templates SET category = 'MARKETING' WHERE name = 'tpl_u'").run();
    expect(await send(ws, 'tpl_u', ['x'])).toEqual({ status: 'failed', sent: 0 });
  });
  it('the inbox API refuses it up front with 409 template_not_approved', async () => {
    const { ws, api } = await member(); await join(api, ws);
    await exec(ws, 'INSERT OR IGNORE INTO contacts (wa_id, profile_name) VALUES (?, ?)', '201001234567', 'c');
    await exec(ws, 'INSERT OR IGNORE INTO conversations (contact_id, last_message_at) SELECT id, 1 FROM contacts WHERE wa_id = ?', '201001234567');
    const conv = (await rows<{ id: number }>(ws, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id'))[0]!.id;
    const post = (name: string) => fetchWith()(`https://x/api/v1/stores/${ws}/conversations/${conv}/messages`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'template', clientId: crypto.randomUUID(), name, language: 'ar', params: ['x'] }) });
    const bad = await post('tpl_m');
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ error: 'template_not_approved' });
    expect((await post('tpl_u')).status).toBe(202);
  });
  it('a store with its own number is untouched by the platform catalog', async () => {
    const ws = W(2299);
    const api = await apiFor(ws);
    await setupBilling(W(2799));
    await fund(ws, 100_000);
    await seedTemplate(ws, { name: 'mine_m', category: 'MARKETING', components: JSON.stringify([{ type: 'BODY', text: 'hi {{1}}' }]) });
    const r = await api.call('POST', '/templates/sync').then(() => true);
    expect(r).toBe(true);
    await exec(ws, "INSERT OR REPLACE INTO templates (name, language, category, status, components, updated_at) VALUES ('mine_u', 'ar', 'UTILITY', 'APPROVED', '[{\"type\":\"BODY\",\"text\":\"hi\"}]', 1)");
    await exec(ws, 'INSERT OR IGNORE INTO contacts (wa_id, profile_name) VALUES (?, ?)', '201001234567', 'c');
    await exec(ws, 'INSERT OR IGNORE INTO conversations (contact_id, last_message_at) SELECT id, 1 FROM contacts WHERE wa_id = ?', '201001234567');
    const conv = (await rows<{ id: number }>(ws, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id'))[0]!.id;
    const res = await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: crypto.randomUUID(), name: 'mine_u', language: 'ar', params: [] });
    expect(res.status).toBe(202);
  });
});


describe('the category and status that count are Meta\'s latest answer (WA-SHARED-NOCAMP-1 cannot be bypassed by recategorisation)', () => {
  const body = { name: 'order_ready', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'طلبك {{1}} جاهز' }] };
  const submitAnswering = (answer: Record<string, unknown>) => {
    graph!.restore();
    graph = graphStub((c) => (c.url.endsWith('/message_templates') && c.method === 'POST' ? { status: 200, json: { id: 'n1', ...answer } } : { status: 200, json: { messages: [{ id: `wamid.${Math.random()}` }] } }));
  };
  const sendable = (name = 'order_ready') => import('../src/core/shared/shared-templates').then((m) => m.sharedTemplateSendable(env, PLAT, name, 'ar'));
  const hook = async (raw: string) => fetchWith()('https://x/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': await sign(raw) }, body: raw });

  it('Meta answers MARKETING to a UTILITY request: the row stores MARKETING and it is not sendable, even once approved', async () => {
    submitAnswering({ status: 'APPROVED', category: 'MARKETING' });
    expect((await op('POST', '', body)).status).toBe(201);
    expect(await catalog()).toEqual([{ name: 'order_ready', language: 'ar', category: 'MARKETING', status: 'APPROVED' }]);
    expect(await sendable()).toBe(false);
  });
  it('the answer is stored upper-cased as Meta gave it; a lower-case answer cannot slip a marketing template through', async () => {
    submitAnswering({ status: 'approved', category: 'marketing' });
    await op('POST', '', body);
    expect(await catalog()).toEqual([{ name: 'order_ready', language: 'ar', category: 'MARKETING', status: 'APPROVED' }]);
    expect(await sendable()).toBe(false);
  });
  it('an answer that does not state a category is stored as unconfirmed (not our request) and is not sendable until a sync says what it is', async () => {
    submitAnswering({ status: 'APPROVED' });
    await op('POST', '', body);
    expect((await catalog())[0]!.category).toBe('UNCONFIRMED');
    expect(await sendable()).toBe(false);
  });
  it('a UTILITY template that a later sync reports as MARKETING stops going out at send time', async () => {
    submitAnswering({ status: 'APPROVED', category: 'UTILITY' });
    await op('POST', '', body);
    expect(await sendable()).toBe(true);
    graph!.restore();
    graph = graphStub((c) => (c.method === 'GET' ? { status: 200, json: { data: [metaTpl('order_ready', 'MARKETING')] } } : { status: 200, json: {} }));
    await op('POST', '/sync', {});
    expect(await sendable()).toBe(false);
  });
  it('a webhook for another WABA changes nothing; one for a template not in the catalog is recorded as a tightened placeholder (never sendable)', async () => {
    submitAnswering({ status: 'APPROVED', category: 'UTILITY' });
    await op('POST', '', body);
    await hook(templateCategoryPayload('other-waba', { name: 'order_ready', language: 'ar', previous: 'UTILITY', next: 'MARKETING' }));
    expect(await catalog()).toEqual([{ name: 'order_ready', language: 'ar', category: 'UTILITY', status: 'APPROVED' }]);
    await hook(templateCategoryPayload(WABA, { name: 'unknown_tpl', language: 'ar', previous: 'UTILITY', next: 'MARKETING' }));
    expect(await catalog()).toEqual([
      { name: 'order_ready', language: 'ar', category: 'UTILITY', status: 'APPROVED' },
      { name: 'unknown_tpl', language: 'ar', category: 'MARKETING', status: 'PENDING' },
    ]);
    expect(await sendable('unknown_tpl')).toBe(false);
  });

  // ---- direction of Meta's events: tighten at once, loosen only from a fresh Graph read ----------------------------------------------
  /** Moves the recorded tightening 5 s into the past (no sleeping): a read that starts now is newer than it. */
  const ageTightening = () => env.DB.prepare("UPDATE shared_templates SET tightened_at = tightened_at - 5 WHERE name = 'order_ready'").run();
  const rowOf = () => env.DB.prepare("SELECT category, status FROM shared_templates WHERE name = 'order_ready'").first<{ category: string; status: string }>();
  const statusEv = (event: string) => hook(templateStatusPayload(WABA, { event, name: 'order_ready', language: 'ar' }));
  const categoryEv = (previous: string, next: string) => hook(templateCategoryPayload(WABA, { name: 'order_ready', language: 'ar', previous, next }));
  /** An approved utility template; Graph answers `current` (category, status) to a by-name lookup, or is down. */
  async function seeded(current: { category: string; status: string } | 'down' = { category: 'UTILITY', status: 'APPROVED' }) {
    submitAnswering({ status: 'APPROVED', category: 'UTILITY' });
    await op('POST', '', body);
    const calls: { url: string; auth: string | undefined }[] = [];
    graph!.restore();
    graph = graphStub((c) => {
      if (c.method === 'GET' && c.url.includes('/message_templates')) {
        calls.push({ url: c.url, auth: c.headers.authorization });
        return current === 'down' ? { status: 500, json: { error: { message: 'down' } } } : { status: 200, json: { data: [metaTpl('order_ready', current.category, current.status)] } };
      }
      return { status: 200, json: {} };
    });
    return calls;
  }

  it('tightening applies at once and needs no Graph call: PAUSED, REJECTED, DISABLED, PENDING and a move to MARKETING', async () => {
    const graphCalls = await seeded();
    for (const [event, status] of [['PAUSED', 'PAUSED'], ['REJECTED', 'REJECTED'], ['DISABLED', 'DISABLED'], ['IN_APPEAL', 'PENDING']] as const) {
      await env.DB.prepare("UPDATE shared_templates SET status = 'APPROVED', tightened_at = NULL WHERE name = 'order_ready'").run();
      await statusEv(event);
      expect((await rowOf())!.status, event).toBe(status);
    }
    await categoryEv('UTILITY', 'MARKETING');
    expect((await rowOf())!.category).toBe('MARKETING');
    expect(graphCalls).toHaveLength(0);
  });
  it('tightening is applied even when Graph is down (it can only make the template less sendable)', async () => {
    await seeded('down');
    const res = await statusEv('PAUSED');
    expect(res.status).toBe(200);
    expect((await rowOf())!.status).toBe('PAUSED');
    expect(await sendable()).toBe(false);
  });
  it('an old APPROVED arriving after PAUSED does not make the template sendable: only Graph can loosen, and Graph says paused', async () => {
    const calls = await seeded({ category: 'UTILITY', status: 'PAUSED' });
    await statusEv('PAUSED');
    await statusEv('APPROVED'); // a late or redelivered event
    expect(calls).toHaveLength(1); // the loosening event was checked against Graph, not applied
    expect(decodeURIComponent(calls[0]!.url)).toContain('name=order_ready');
    expect(calls[0]!.auth).toBe(`Bearer ${PLATFORM_TOKEN}`);
    expect((await rowOf())!.status).toBe('PAUSED');
    expect(await sendable()).toBe(false);
  });
  it('a redelivered UTILITY after MARKETING keeps it marketing when Graph still says marketing', async () => {
    const calls = await seeded({ category: 'MARKETING', status: 'APPROVED' });
    await categoryEv('UTILITY', 'MARKETING');
    await categoryEv('MARKETING', 'UTILITY');
    expect(calls).toHaveLength(1);
    expect((await rowOf())!.category).toBe('MARKETING');
    expect(await sendable()).toBe(false);
  });
  it('...and loosening happens only from Graph\'s fresh answer: when Graph confirms, the row loosens (status and category)', async () => {
    const calls = await seeded({ category: 'UTILITY', status: 'APPROVED' });
    await statusEv('PAUSED');
    await categoryEv('UTILITY', 'MARKETING');
    expect(await sendable()).toBe(false);
    await ageTightening(); // the Graph read below starts later than the tightening on the local clock
    await statusEv('APPROVED');
    expect(calls).toHaveLength(1);
    expect(await rowOf()).toEqual({ category: 'UTILITY', status: 'APPROVED' });
    expect(await sendable()).toBe(true);
  });
  it('if Graph cannot be reached a loosening event changes nothing, the webhook still answers 200, and an alert is logged', async () => {
    await seeded('down');
    await statusEv('PAUSED');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await statusEv('APPROVED');
    expect(res.status).toBe(200);
    expect((await rowOf())!.status).toBe('PAUSED');
    expect(err.mock.calls.map((c) => String(c[0])).some((l) => l.includes('shared_template_refresh_failed'))).toBe(true);
    err.mockRestore();
  });
  it('a sync that STARTED before a tightening webhook and finishes after it cannot undo it', async () => {
    await seeded();
    graph!.restore();
    graph = graphStub(
      () => ({ status: 200, json: { data: [metaTpl('order_ready', 'UTILITY', 'APPROVED')] } }), // Graph read before the pause: approved
      undefined,
      async (call) => { if (call.method === 'GET') { await statusEv('PAUSED'); } }, // the pause webhook lands while the sync is in flight
    );
    expect((await op('POST', '/sync', {})).status).toBe(200);
    expect((await rowOf())!.status).toBe('PAUSED');
    expect(await sendable()).toBe(false);
  });
  it('the same holds for a refresh triggered by a loosening webhook', async () => {
    await seeded();
    await statusEv('PAUSED');
    await ageTightening();
    graph!.restore();
    graph = graphStub(
      () => ({ status: 200, json: { data: [metaTpl('order_ready', 'UTILITY', 'APPROVED')] } }),
      undefined,
      async (call) => { if (call.method === 'GET') { await categoryEv('UTILITY', 'MARKETING'); } }, // tightens mid-read
    );
    await statusEv('APPROVED');
    expect(await rowOf()).toEqual({ category: 'MARKETING', status: 'PAUSED' }); // a tightening landed during the read: the whole row stays tight (the guard is per row)
    expect(await sendable()).toBe(false);
  });
  it('a sync tightens at once and never loosens past a recorded tightening; it upserts (a template Meta no longer lists is disabled, not deleted)', async () => {
    await seeded();
    await statusEv('PAUSED');
    graph!.restore();
    graph = graphStub(() => ({ status: 200, json: { data: [] } }));
    const r = await op('POST', '/sync', {});
    expect(await r.json()).toEqual({ upserted: 0, removed: 1 });
    expect(await rowOf()).toMatchObject({ status: 'DISABLED' });
  });

  it('the tightening and the read start are stamped with the DATABASE clock (seconds), not an isolate\'s Date.now()', async () => {
    await seeded();
    const t0 = (await env.DB.prepare("SELECT unixepoch('subsec') AS t").first<{ t: number }>())!.t;
    await statusEv('PAUSED');
    const t1 = (await env.DB.prepare("SELECT unixepoch('subsec') AS t").first<{ t: number }>())!.t;
    const at = (await env.DB.prepare("SELECT tightened_at AS t FROM shared_templates WHERE name = 'order_ready'").first<{ t: number }>())!.t;
    expect(at).toBeGreaterThanOrEqual(t0 - 0.001);
    expect(at).toBeLessThanOrEqual(t1 + 0.001);
  });

  it('two shared numbers on ONE WABA share one catalog: a pause blocks both at send, and a sync does not double the rows', async () => {
    const PLAT2 = '5550002';
    await env.DB.prepare("INSERT INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, ?, '+20 100 555 0002', 2)").bind(PLAT2, WABA).run();
    await seeded();
    expect(await catalog()).toHaveLength(1);
    const ok = (num: string) => import('../src/core/shared/shared-templates').then((m) => m.sharedTemplateSendable(env, num, 'order_ready', 'ar'));
    expect([await ok(PLAT), await ok(PLAT2)]).toEqual([true, true]);
    await statusEv('PAUSED');
    expect([await ok(PLAT), await ok(PLAT2)]).toEqual([false, false]);
  });
});
