import { createExecutionContext, createMessageBatch, env, getQueueResult } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { brandPack } from '../src/brand';
import { customerKey, displayNameKey } from '../src/core/shared/shared-number';
import type { SendJob } from '../src/core/send-queue';
import { adminToken, apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { sign } from './helpers/meta';
import { inboundPayload, rawMessagePayload, listReply, statusPayload } from './helpers/payload';
import { seedTemplate } from './helpers/campaigns';
import { setupBilling, fund } from './helpers/billing';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof graphStub> | undefined;
afterEach(() => graph?.restore());

// Every request goes through the deployed Worker module with the switch on and nothing else configured: no test-only configure call.
const ON = { SHARED_NUMBER_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
const envWith = (over: Record<string, unknown> = {}) => ({ ...env, ...ON, ...over }) as typeof env;
const fetchWith = (over: Record<string, unknown> = {}) => (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), envWith(over), createExecutionContext());

const PLAT = '5550001';
const WABA = '4440001';
const CUST = '201001234567';
const CUST2 = '201112223333';
const NOW_S = () => Math.floor(Date.now() / 1000);
let seq = 0;
const wm = (p = 'in') => `wamid.${p}.${++seq}.${Date.now()}`;

async function hook(raw: string, over: Record<string, unknown> = {}) {
  return fetchWith(over)('https://x/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': await sign(raw) }, body: raw });
}
const inbound = (text: string, from = CUST, id = wm()) => hook(inboundPayload(PLAT, [{ id, from, text, ts: NOW_S() }]));
const pick = (wsId: string, from = CUST) => hook(rawMessagePayload(PLAT, listReply(wm('pick'), `shared:pick:${wsId}`, 'x', from)));

async function operatorRegister(body: Record<string, unknown> = { phoneNumberId: PLAT, wabaId: WABA, displayPhone: '+20 100 555 0001', reason: 'platform number setup' }, over: Record<string, unknown> = {}) {
  const token = await adminToken();
  return fetchWith(over)('https://x/api/v1/operator/shared-numbers', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function store(n: number, role: 'owner' | 'staff' = 'owner') {
  const ws = W(n);
  const api = await apiFor(ws, role);
  const call = (method: string, path: string, body?: unknown, over: Record<string, unknown> = {}) =>
    fetchWith(over)(`https://x/api/v1/stores/${ws}${path}`, { method, headers: { authorization: `Bearer ${api.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { ws, call };
}
/** A store that joined the shared number with a funded wallet and an approved template, ready to write to a customer. */
async function member(n: number, name: string) {
  const s = await store(n);
  await setupBilling(s.ws, { funding: null });
  await fund(s.ws, 100_000);
  await seedTemplate(s.ws, { name: 'tpl-u', category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi' }]) });
  expect((await s.call('POST', '/shared-number/join', { displayName: name })).status).toBe(200);
  return s;
}
/** The store writes to a customer from the platform number: the real path (queue the template, run the send consumer). Returns the wamid Meta gave. */
async function writeTo(ws: string, waId = CUST, orderRef?: string): Promise<{ wamid: string; job: SendJob }> {
  await exec(ws, 'INSERT OR IGNORE INTO contacts (wa_id, profile_name) VALUES (?, ?)', waId, 'c');
  await exec(ws, 'INSERT OR IGNORE INTO conversations (contact_id, last_message_at) SELECT id, 1 FROM contacts WHERE wa_id = ?', waId);
  const convId = (await rows<{ id: number }>(ws, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', waId))[0]!.id;
  const r = await workspace(ws).queueOutbound(convId, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
  if (!r.ok || !r.job) throw new Error(`not queued: ${JSON.stringify(r)}`);
  const job: SendJob = orderRef ? { ...r.job, orderRef } : r.job;
  const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: job }]);
  const ctx = createExecutionContext();
  await worker.queue(batch, envWith(), ctx);
  const res = await getQueueResult(batch, ctx);
  expect(res.explicitAcks).toEqual(['m0']);
  const wamid = (await rows<{ wamid: string }>(ws, "SELECT wamid FROM messages WHERE idempotency_key = ?", job.idempotencyKey))[0]!.wamid;
  return { wamid, job };
}
const msgs = (ws: string) => rows<{ body: string | null; direction: string; wamid: string | null; status: string | null }>(ws, "SELECT body, direction, wamid, status FROM messages WHERE direction = 'in' ORDER BY id");
const routes = (ws?: string) => env.DB.prepare(`SELECT * FROM shared_routes ${ws ? 'WHERE workspace_id = ?' : ''} ORDER BY workspace_id`).bind(...(ws ? [ws] : [])).all<Record<string, any>>().then((r) => r.results);
const lists = () => graph!.calls.filter((c) => c.body?.type === 'interactive' && c.body.interactive?.type === 'list');
const texts = () => graph!.calls.filter((c) => c.body?.type === 'text');

beforeEach(async () => {
  graph = graphStub();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_routes'), env.DB.prepare('DELETE FROM shared_sent'),
    env.DB.prepare('DELETE FROM shared_number_members'), env.DB.prepare('DELETE FROM shared_numbers'),
    env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(PLAT),
  ]);
  for (const o of (await env.MEDIA.list({ prefix: 'shared-' })).objects) await env.MEDIA.delete(o.key);
});

describe('setup', () => {
  it('the operator registers the platform number and its funding (platform_line) in one write; nobody else can; off = 404', async () => {
    expect((await operatorRegister()).status).toBe(201);
    expect(await env.DB.prepare('SELECT waba_id, display_phone FROM shared_numbers WHERE phone_number_id = ?').bind(PLAT).first()).toEqual({ waba_id: WABA, display_phone: '+20 100 555 0001' });
    expect(await env.DB.prepare('SELECT funding FROM number_funding WHERE phone_number_id = ?').bind(PLAT).first('funding')).toBe('platform_line');
    expect(await env.DB.prepare("SELECT action FROM billing_audit WHERE action = 'shared_number_registered'").first('action')).toBe('shared_number_registered');
    // idempotent
    expect((await operatorRegister()).status).toBe(201);
    // a store owner is not an operator
    const s = await store(701);
    const res = await fetchWith()('https://x/api/v1/operator/shared-numbers', { method: 'POST', headers: { authorization: `Bearer ${(await apiFor(s.ws)).token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    expect((await operatorRegister(undefined, { SHARED_NUMBER_ENABLED: undefined })).status).toBe(404);
    expect((await operatorRegister({ phoneNumberId: 'x', wabaId: WABA, reason: 'bad id' })).status).toBe(400);
  });

  it('a number a store already owns cannot become the platform number', async () => {
    const s = await store(702);
    await exec(s.ws, 'SELECT 1');
    await env.DB.prepare("INSERT OR IGNORE INTO phone_numbers (phone_number_id, waba_id, workspace_id, status) VALUES ('5550999', '1', ?, 'active')").bind(s.ws).run();
    expect((await operatorRegister({ phoneNumberId: '5550999', wabaId: '1', reason: 'must be refused' })).status).toBe(409);
  });

  it('join and leave: owner only, the wallet funding appears and disappears in the store copy, routes go on leaving', async () => {
    await operatorRegister();
    const s = await store(703);
    const staff = await store(703, 'staff');
    expect((await staff.call('POST', '/shared-number/join', {})).status).toBe(403);
    expect(await (await s.call('GET', '/shared-number')).json()).toEqual({ available: true, member: false, displayName: null, displayPhone: '+20 100 555 0001', packageRequired: false });
    expect((await s.call('POST', '/shared-number/join', { displayName: 'x' })).status).toBe(400);
    expect((await s.call('POST', '/shared-number/join', { displayName: 'متجر النور' })).status).toBe(200);
    expect(await (await s.call('GET', '/shared-number')).json()).toMatchObject({ member: true, displayName: 'متجر النور' });
    expect(await rows(s.ws, 'SELECT funding FROM number_funding WHERE phone_number_id = ?', PLAT)).toEqual([{ funding: 'platform_line' }]);
    await env.DB.prepare("INSERT INTO shared_routes (phone_number_id, customer_key, workspace_id, last_at) VALUES (?, 'k', ?, 1)").bind(PLAT, s.ws).run();
    expect((await staff.call('POST', '/shared-number/leave')).status).toBe(403);
    expect((await s.call('POST', '/shared-number/leave')).status).toBe(200);
    expect(await (await s.call('GET', '/shared-number')).json()).toMatchObject({ member: false });
    expect(await rows(s.ws, 'SELECT funding FROM number_funding WHERE phone_number_id = ?', PLAT)).toEqual([]);
    expect(await routes(s.ws)).toEqual([]);
  });

  it('the switch off: every shared-number route is 404', async () => {
    await operatorRegister();
    const s = await store(704);
    for (const [m, p] of [['GET', '/shared-number'], ['POST', '/shared-number/join'], ['POST', '/shared-number/leave']] as const) {
      expect((await s.call(m, p, m === 'POST' ? {} : undefined, { SHARED_NUMBER_ENABLED: undefined })).status).toBe(404);
    }
    expect((await s.call('GET', '/me', undefined, { SHARED_NUMBER_ENABLED: undefined })).status).toBe(200);
  });
});

describe('sending from the platform number', () => {
  it('uses the platform token, bills the wallet (platform_line) and records the route, the order and the sent message', async () => {
    await operatorRegister();
    const a = await member(710, 'متجر النور');
    const { wamid } = await writeTo(a.ws, CUST, 'order-77');
    expect(graph!.calls.at(-1)!.headers.authorization).toBe(`Bearer ${env.META_SYSTEM_TOKEN}`);
    expect(graph!.calls.at(-1)!.url).toContain(`/${PLAT}/messages`);
    const key = await customerKey(env, CUST);
    expect(await routes(a.ws)).toEqual([expect.objectContaining({ phone_number_id: PLAT, customer_key: key, workspace_id: a.ws, order_ref: 'order-77' })]);
    expect(JSON.stringify(await routes())).not.toContain(CUST);
    expect(await env.DB.prepare('SELECT workspace_id, customer_key FROM shared_sent WHERE wamid = ?').bind(wamid).first()).toEqual({ workspace_id: a.ws, customer_key: key });
    expect((await rows<{ funding: string }>(a.ws, "SELECT funding FROM billable_sends WHERE number_id = ?", PLAT))[0]).toEqual({ funding: 'platform_line' });
  });

  it('fails closed without a funding row: the send is refused at queue time and nothing reaches Meta', async () => {
    await operatorRegister();
    const a = await member(711, 'متجر النور');
    await env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(PLAT).run();
    await workspace(a.ws).refreshPricing();
    await exec(a.ws, "INSERT OR IGNORE INTO contacts (wa_id) VALUES ('201001234567')");
    await exec(a.ws, 'INSERT OR IGNORE INTO conversations (contact_id, last_message_at) SELECT id, 1 FROM contacts');
    const conv = (await rows<{ id: number }>(a.ws, 'SELECT id FROM conversations'))[0]!.id;
    const r = await workspace(a.ws).queueOutbound(conv, PLAT, { type: 'template', clientId: crypto.randomUUID(), name: 'tpl-u', language: 'ar', params: [] });
    expect(r).toMatchObject({ ok: false, reason: 'funding_unknown' });
    expect(graph!.calls).toHaveLength(0);
  });

  it('a store that is not a member (or left) cannot send from it: the job is dropped before Meta', async () => {
    await operatorRegister();
    const a = await member(712, 'متجر النور');
    const { job } = await writeTo(a.ws);
    const before = graph!.calls.length;
    expect((await a.call('POST', '/shared-number/leave')).status).toBe(200);
    const again: SendJob = { ...job, idempotencyKey: 'ui:after-leave' };
    const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: again }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, envWith(), ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m0']);
    expect(graph!.calls).toHaveLength(before);
  });

  it('the switch off: a queued member job is dropped, not sent', async () => {
    await operatorRegister();
    const a = await member(713, 'متجر النور');
    await exec(a.ws, "INSERT OR IGNORE INTO contacts (wa_id) VALUES ('201001234567')");
    const job: SendJob = { workspaceId: a.ws, phoneNumberId: PLAT, to: CUST, text: 'x', idempotencyKey: 'off:1' };
    const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: job }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, envWith({ SHARED_NUMBER_ENABLED: undefined }), ctx);
    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m0']);
    expect(graph!.calls).toHaveLength(0);
  });
});

describe('inbound routing', () => {
  it('a reply goes to the store that last wrote to the customer, and to nobody else', async () => {
    await operatorRegister();
    const a = await member(720, 'متجر النور');
    const b = await member(721, 'متجر الأمل');
    await writeTo(a.ws);
    const before = graph!.calls.length;
    expect((await inbound('عايز أعرف الميعاد')).status).toBe(200);
    expect((await msgs(a.ws)).map((m) => m.body)).toEqual(['عايز أعرف الميعاد']);
    expect(await msgs(b.ws)).toEqual([]);
    expect(graph!.calls.length).toBe(before); // no list, no generic reply
    // a later reply from the same customer keeps going to A; a different customer has no route
    await inbound('شكراً');
    expect(await msgs(a.ws)).toHaveLength(2);
  });

  it('ambiguity: two stores wrote within 24 h → ONE list with display names, the message waits, the tap routes it (and what follows) to the chosen store', async () => {
    await operatorRegister();
    const a = await member(722, 'متجر النور');
    const b = await member(723, 'متجر الأمل');
    await writeTo(a.ws);
    await writeTo(b.ws);
    const before = graph!.calls.length;
    await inbound('أنا عايز أسأل');
    await inbound('ولسه عندي سؤال تاني'); // a second message while waiting
    expect(await msgs(a.ws)).toEqual([]);
    expect(await msgs(b.ws)).toEqual([]);
    expect(lists()).toHaveLength(1); // ONE list, however many messages wait
    const list = lists()[0]!.body.interactive;
    expect(list.action.sections[0].rows.map((r: { title: string }) => r.title).sort()).toEqual(['متجر الأمل', 'متجر النور']);
    expect(list.action.sections[0].rows.map((r: { id: string }) => r.id).sort()).toEqual([`shared:pick:${a.ws}`, `shared:pick:${b.ws}`].sort());
    expect(list.body.text).toBe(brandPack(undefined).sharedNumber.pickBody);
    expect(graph!.calls.length).toBe(before + 1);
    // the tap
    expect((await pick(b.ws)).status).toBe(200);
    expect((await msgs(b.ws)).map((m) => m.body)).toEqual(['أنا عايز أسأل', 'ولسه عندي سؤال تاني']);
    expect(await msgs(a.ws)).toEqual([]);
    expect(await env.MEDIA.list({ prefix: 'shared-parked/' }).then((l) => l.objects)).toEqual([]); // nothing left waiting
    // future replies go to the chosen store, no list again
    await inbound('تمام');
    expect((await msgs(b.ws)).map((m) => m.body).at(-1)).toBe('تمام');
    expect(await msgs(a.ws)).toEqual([]);
    expect(lists()).toHaveLength(1);
    // the other store writing again makes it ambiguous again
    await new Promise((r) => setTimeout(r, 5));
    await writeTo(a.ws);
    await inbound('رد جديد');
    expect(lists()).toHaveLength(2);
    expect((await msgs(a.ws)).map((m) => m.body)).not.toContain('رد جديد');
  });

  it('a redelivered tap does not lose or duplicate the parked messages', async () => {
    await operatorRegister();
    const a = await member(724, 'متجر النور');
    const b = await member(725, 'متجر الأمل');
    await writeTo(a.ws);
    await writeTo(b.ws);
    await inbound('رسالة معلقة');
    const raw = rawMessagePayload(PLAT, listReply(wm('pick'), `shared:pick:${a.ws}`, 'x'));
    expect((await hook(raw)).status).toBe(200);
    expect((await hook(raw)).status).toBe(200);
    expect((await msgs(a.ws)).map((m) => m.body)).toEqual(['رسالة معلقة']);
  });

  it('no route at all: one polite generic reply a day, nothing stored in any store', async () => {
    await operatorRegister();
    const a = await member(726, 'متجر النور');
    const b = await member(727, 'متجر الأمل');
    await inbound('أهلاً');
    await inbound('فيه حد؟');
    expect(texts()).toHaveLength(1);
    expect(texts()[0]!.body.text.body).toBe(brandPack(undefined).sharedNumber.noRoute);
    expect(texts()[0]!.body.to).toBe(CUST);
    expect(await msgs(a.ws)).toEqual([]);
    expect(await msgs(b.ws)).toEqual([]);
    expect(await rows(a.ws, 'SELECT count(*) AS n FROM contacts')).toEqual([{ n: 0 }]);
  });

  it('a route of a store that left is no route', async () => {
    await operatorRegister();
    const a = await member(728, 'متجر النور');
    await writeTo(a.ws);
    await env.DB.prepare("UPDATE shared_number_members SET status = 'left' WHERE workspace_id = ?").bind(a.ws).run();
    await inbound('أهلاً');
    expect(await msgs(a.ws)).toEqual([]);
    expect(texts()).toHaveLength(1);
  });

  it('isolation: the list shows store names only; a store never sees the other store, its customer or its conversation', async () => {
    await operatorRegister();
    const a = await member(730, 'متجر النور');
    const b = await member(731, 'متجر الأمل');
    await writeTo(a.ws, CUST);
    await writeTo(b.ws, CUST);
    await writeTo(b.ws, CUST2); // B also has another customer A knows nothing about
    await inbound('سؤال للمتجر', CUST);
    await pick(a.ws);
    expect((await msgs(a.ws)).map((m) => m.body)).toEqual(['سؤال للمتجر']);
    expect(await rows(a.ws, 'SELECT wa_id FROM contacts ORDER BY wa_id')).toEqual([{ wa_id: CUST }]); // A never learnt CUST2
    expect(await msgs(b.ws)).toEqual([]);
    const listBody = JSON.stringify(lists()[0]!.body);
    expect(listBody).not.toContain(CUST2);
    expect(listBody).not.toContain('سؤال للمتجر'); // the message text is never put into the list
    // nothing the customer sent is in D1
    expect(JSON.stringify(await routes())).not.toContain('سؤال');
    // a tap naming a store the customer never heard from is ignored
    const stranger = await member(732, 'متجر غريب');
    await pick(stranger.ws);
    expect(await msgs(stranger.ws)).toEqual([]);
    expect((await routes(stranger.ws))).toEqual([]);
  });
});

describe('opt-out and erasure', () => {
  it('STOP with one route opts out of that store only', async () => {
    await operatorRegister();
    const a = await member(740, 'متجر النور');
    const b = await member(741, 'متجر الأمل');
    await writeTo(a.ws);
    await inbound('STOP');
    expect(await rows(a.ws, 'SELECT opted_out_at FROM contacts WHERE wa_id = ?', CUST)).toEqual([{ opted_out_at: expect.any(Number) }]);
    expect(await rows(b.ws, 'SELECT count(*) AS n FROM contacts')).toEqual([{ n: 0 }]);
  });

  it('STOP while ambiguous opts out of every store that wrote to the customer, with no list and nothing parked', async () => {
    await operatorRegister();
    const a = await member(742, 'متجر النور');
    const b = await member(743, 'متجر الأمل');
    await writeTo(a.ws);
    await writeTo(b.ws);
    await inbound('stop');
    for (const w of [a.ws, b.ws]) expect(await rows(w, 'SELECT opted_out_at FROM contacts WHERE wa_id = ?', CUST)).toEqual([{ opted_out_at: expect.any(Number) }]);
    expect(lists()).toHaveLength(0);
    expect(await env.MEDIA.list({ prefix: 'shared-parked/' }).then((l) => l.objects)).toEqual([]);
  });

  it('STOP with no route stores nothing and sends nothing', async () => {
    await operatorRegister();
    const a = await member(744, 'متجر النور');
    const before = graph!.calls.length;
    await inbound('STOP');
    expect(graph!.calls.length).toBe(before);
    expect(await rows(a.ws, 'SELECT count(*) AS n FROM contacts')).toEqual([{ n: 0 }]);
  });

  it('erasing a contact in one store removes that store\'s routes and sent-message map, and only that store\'s', async () => {
    await operatorRegister();
    const a = await member(745, 'متجر النور');
    const b = await member(746, 'متجر الأمل');
    await writeTo(a.ws);
    await writeTo(b.ws);
    const res = await a.call('DELETE', `/contacts/${CUST}`);
    expect(res.status).toBe(200);
    expect(await routes(a.ws)).toEqual([]);
    expect(await routes(b.ws)).toHaveLength(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM shared_sent WHERE workspace_id = ?').bind(a.ws).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM shared_sent WHERE workspace_id = ?').bind(b.ws).first<{ n: number }>())!.n).toBe(1);
  });
});

describe('statuses', () => {
  it('a delivery status reaches the store that sent the message and no other; an unknown message id is dropped', async () => {
    await operatorRegister();
    const a = await member(750, 'متجر النور');
    const b = await member(751, 'متجر الأمل');
    const { wamid } = await writeTo(a.ws);
    expect(await rows(a.ws, 'SELECT status FROM messages WHERE wamid = ?', wamid)).toEqual([{ status: 'accepted' }]);
    expect((await hook(statusPayload(PLAT, [{ id: wamid, status: 'delivered' }, { id: 'wamid.unknown', status: 'delivered' }]))).status).toBe(200);
    expect(await rows(a.ws, 'SELECT status FROM messages WHERE wamid = ?', wamid)).toEqual([{ status: 'delivered' }]);
    expect(await rows(b.ws, 'SELECT count(*) AS n FROM message_status_events')).toEqual([{ n: 0 }]);
  });
});

describe('switch off', () => {
  it('the platform number is unknown to the webhook: 200, nothing stored, nothing sent', async () => {
    await operatorRegister();
    const a = await member(760, 'متجر النور');
    await writeTo(a.ws);
    const before = graph!.calls.length;
    const raw = inboundPayload(PLAT, [{ id: wm(), from: CUST, text: 'hi', ts: NOW_S() }]);
    expect((await hook(raw, { SHARED_NUMBER_ENABLED: undefined })).status).toBe(200);
    expect(await msgs(a.ws)).toEqual([]);
    expect(graph!.calls.length).toBe(before);
  });
});

describe('brand packs', () => {
  it('every pack carries the shared number words within WhatsApp limits; the white-label pack names no suite brand', () => {
    for (const id of [undefined, 'demo']) {
      const c = brandPack(id).sharedNumber;
      expect(c.pickBody.length).toBeGreaterThan(0);
      expect(c.pickBody.length).toBeLessThanOrEqual(1024);
      expect(c.pickButton.length).toBeLessThanOrEqual(20);
      expect(c.pickFooter.length).toBeLessThanOrEqual(60);
      expect(c.noRoute.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(brandPack('demo').sharedNumber)).not.toMatch(/ebda|إبدا/i);
  });
});

describe('security review fixes (2026-10-25)', () => {
  /** Queue + consume one job without assuming Meta accepted it. */
  async function consumeJob(job: SendJob) {
    const batch = createMessageBatch<SendJob>('ebda-wa-send', [{ id: 'm0', timestamp: new Date(), attempts: 1, body: job }]);
    const ctx = createExecutionContext();
    await worker.queue(batch, envWith(), ctx);
    return getQueueResult(batch, ctx);
  }

  it('a send Meta refuses claims no route: the customer\'s replies stay with the store they deal with', async () => {
    await operatorRegister();
    const a = await member(770, 'متجر النور');
    const b = await member(771, 'متجر الأمل');
    await writeTo(a.ws);
    graph!.restore();
    graph = graphStub(() => ({ status: 400, json: { error: { code: 131026, message: 'undeliverable' } } }));
    await exec(b.ws, 'INSERT OR IGNORE INTO contacts (wa_id) VALUES (?)', CUST);
    await consumeJob({ workspaceId: b.ws, phoneNumberId: PLAT, to: CUST, text: 'عرض خاص', idempotencyKey: 'refused:1' });
    expect(await routes(b.ws)).toEqual([]);
    graph!.restore();
    graph = graphStub();
    await inbound('فين طلبي؟');
    expect((await msgs(a.ws)).map((m) => m.body)).toEqual(['فين طلبي؟']);
    expect(lists()).toHaveLength(0);
  });

  it('a second store writing to an established customer, even days later, is never a silent takeover: the customer chooses', async () => {
    await operatorRegister();
    const a = await member(772, 'متجر النور');
    const b = await member(773, 'متجر الأمل');
    await writeTo(a.ws);
    await env.DB.prepare('UPDATE shared_routes SET last_at = ? WHERE workspace_id = ?').bind(Date.now() - 3 * 24 * 3_600_000, a.ws).run();
    await writeTo(b.ws);
    await inbound('أهلاً');
    expect(lists()).toHaveLength(1);
    expect(await msgs(a.ws)).toEqual([]);
    expect(await msgs(b.ws)).toEqual([]);
  });

  it('a store cannot send the platform\'s "which store?" ids: such a message is refused before Meta (real queue path)', async () => {
    await operatorRegister();
    const a = await member(774, 'متجر النور');
    await writeTo(a.ws);
    await inbound('مساء الخير'); // the customer writes: the 24 h window opens, so buttons may be sent at all
    const convId = (await rows<{ id: number }>(a.ws, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', CUST))[0]!.id;
    const before = graph!.calls.length;
    const r = await workspace(a.ws).queueOutbound(convId, PLAT, { type: 'interactive', clientId: crypto.randomUUID(), body: 'اختار المتجر', buttons: [{ id: `shared:pick:${W(775)}`, title: 'متجر تاني' }] });
    if (r.ok && r.job) await consumeJob(r.job);
    expect(graph!.calls.length).toBe(before);
    // control: the same message without the platform prefix does go out
    const ok = await workspace(a.ws).queueOutbound(convId, PLAT, { type: 'interactive', clientId: crypto.randomUUID(), body: 'تأكيد', buttons: [{ id: 'confirm:1', title: 'تمام' }] });
    if (!ok.ok || !ok.job) throw new Error('control message was not queued');
    await consumeJob(ok.job);
    expect(graph!.calls.length).toBe(before + 1);
  });

  it('display names are unique among the number\'s active members, folding case, diacritics, Unicode forms and spacing', async () => {
    await operatorRegister();
    await member(776, 'متجر النور');
    await member(777, 'Al Noor Shop');
    const c = await store(778);
    for (const name of ['مَتجر  النّور', ' متجر النور ', 'al  noor   SHOP', 'Ａｌ Ｎｏｏｒ Ｓｈｏｐ']) {
      const r = await c.call('POST', '/shared-number/join', { displayName: name });
      expect(r.status, name).toBe(409);
    }
    expect((await c.call('POST', '/shared-number/join', { displayName: 'متجر الفجر' })).status).toBe(200);
  });

  it('look-alike letters from other scripts and digit forms count as the same name', async () => {
    await operatorRegister();
    await member(779, 'Cairo Shop 1');
    await member(780, 'متجر كريم ٢');
    const c = await store(781);
    // Cyrillic о/р/С, Greek ο; Persian ک/ی and digit forms; a 1 that reads as l.
    for (const name of ['Cаirо Shор 1', 'Cairο Shop 1', 'Cairo Shop l', 'متجر کریم 2', 'متجر كريم ۲']) {
      const r = await c.call('POST', '/shared-number/join', { displayName: name });
      expect(r.status, name).toBe(409);
    }
  });

  it('the look-alike skeleton is one step: a key never changes when folded again', () => {
    for (const name of ['Cаirо', 'ії ιι 11 ii ll', 'کریم ۲', 'Ａｌｉ']) expect(displayNameKey(displayNameKey(name)), name).toBe(displayNameKey(name));
    expect(displayNameKey('Kіm')).toBe(displayNameKey('Kim'));
  });

  it('a name is stored as the customer will see it: outer spaces and invisible format marks are removed, inner runs of space collapse', async () => {
    await operatorRegister();
    const c = await store(784);
    expect((await c.call('POST', '/shared-number/join', { displayName: '   \u200f\u200dDelta   Shop  ' })).status).toBe(200);
    expect((await env.DB.prepare('SELECT display_name FROM shared_number_members WHERE workspace_id = ?').bind(c.ws).first<{ display_name: string }>())?.display_name).toBe('Delta Shop');
  });

  it('blank-looking letters (Hangul fillers, braille blank, variation selectors) are not a name and do not tell two names apart', async () => {
    await operatorRegister();
    await member(785, 'Delta');
    const c = await store(786);
    expect((await c.call('POST', '/shared-number/join', { displayName: '\u3164\u2800\u115F' })).status).toBe(400);
    expect((await c.call('POST', '/shared-number/join', { displayName: 'Del\uFE0Fta\u3164' })).status).toBe(409);
  });

  it('uniqueness is judged on the name the customer sees in the list, not the full stored name', async () => {
    await operatorRegister();
    await member(782, 'Nile Fashion House Downtown Branch');
    const c = await store(783);
    // Same first 23 characters: the 24-character list row shows both as "Nile Fashion House Down…".
    expect((await c.call('POST', '/shared-number/join', { displayName: 'Nile Fashion House Downstairs' })).status).toBe(409);
    expect((await c.call('POST', '/shared-number/join', { displayName: 'Nile Fashion Uptown' })).status).toBe(200);
  });
});
