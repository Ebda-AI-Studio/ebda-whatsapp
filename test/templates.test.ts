import { SELF, env } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { listTemplatesResponse } from '../src/core/api/contract';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { componentsSchema, paramCount, renderTemplate } from '../src/core/templates';
import { apiFor, graphStub, storeId as W, tokenFor, useApiKey } from './helpers/api';
import { makeCampaign, seedContacts } from './helpers/campaigns';
import type { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { templateStatusPayload } from './helpers/payload';
import { exec, openChat, rows, seedNumber } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

const comps = (v: unknown) => componentsSchema.parse(v);
const CLIENT = '00000000-0000-4000-8000-0000000000a1';

const metaTemplate = (name: string, status = 'APPROVED', extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`, name, language: 'ar', category: 'UTILITY', status, components: [{ type: 'BODY', text: `مرحبا {{1}} ${name}` }], ...extra,
});

it('sync upserts what Meta returns, follows paging, and drops templates Meta no longer has', async () => {
  const api = await apiFor(W(100));
  await exec(W(100), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('gone', 'ar', 'UTILITY', 'APPROVED', '[]', 1)");
  graph = graphStub((c) =>
    c.url.includes('after=CURSOR')
      ? { status: 200, json: { data: [metaTemplate('b', 'REJECTED', { rejected_reason: 'INVALID_FORMAT' })] } }
      : { status: 200, json: { data: [metaTemplate('a')], paging: { next: 'https://graph.facebook.com/v25.0/waba-1/message_templates?after=CURSOR' } } },
  );
  const res = await api.call('POST', '/templates/sync');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ upserted: 2, removed: 1 });
  expect(graph.calls[0]!.url).toMatch(/^https:\/\/graph\.facebook\.com\/v25\.0\/waba-1\/message_templates\?/);
  expect(graph.calls[0]!.headers.authorization).toBe('Bearer test-token');
  const list = listTemplatesResponse.parse(await (await api.call('GET', '/templates')).json());
  expect(list.items.map((t) => [t.name, t.status, t.paramCount, t.rejectedReason])).toEqual([['a', 'APPROVED', 1, null], ['b', 'REJECTED', 1, 'INVALID_FORMAT']]);
  expect(list.items[0]!.bodyText).toBe('مرحبا {{1}} a');
});

it('a failing sync changes nothing', async () => {
  const api = await apiFor(W(101));
  await exec(W(101), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('keep', 'ar', 'UTILITY', 'APPROVED', '[]', 1)");
  graph = graphStub(() => ({ status: 500, json: { error: { code: 1, message: 'boom' } } }));
  expect((await api.call('POST', '/templates/sync')).status).toBe(503);
  expect(await rows(W(101), 'SELECT name FROM templates')).toEqual([{ name: 'keep' }]);
});

it('POST /templates submits to Meta and stores it as PENDING; staff may not', async () => {
  const api = await apiFor(W(102));
  graph = graphStub(() => ({ status: 200, json: { id: '123', status: 'PENDING', category: 'UTILITY' } }));
  const body = await signed(api, draftBody());
  const res = await api.call('POST', '/templates', body);
  expect(res.status).toBe(201);
  expect(graph.calls.filter((c) => c.method === 'POST')[0]!.url).toBe('https://graph.facebook.com/v25.0/waba-1/message_templates');
  expect(graph.calls.filter((c) => c.method === 'POST')[0]!.body).toMatchObject({ name: 'shipping_update', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', example: { body_text: [['أحمد', '1001', 'يومين']] } }] });
  expect(await rows(W(102), 'SELECT name, status FROM templates')).toEqual([{ name: 'shipping_update', status: 'PENDING' }]);
  const staff = await apiFor(W(102), 'staff');
  expect((await staff.call('POST', '/templates', body)).status).toBe(403);
  expect((await api.call('POST', '/templates', await signed(api, draftBody({ name: 'Bad Name!' })))).status).toBe(400);
});

it('a submission without expectedHash is refused 400 hash_required and never reaches Meta, whatever the body shape (the approval is bound to the previewed payload)', async () => {
  const api = await apiFor(W(120));
  graph = graphStub(() => ({ status: 200, json: { id: '1', status: 'PENDING', category: 'UTILITY' } }));
  for (const body of [draftBody(), { name: 'old_shape', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'أهلاً {{1}} طلبك.', example: { body_text: [['1001']] } }] }]) {
    const res = await api.call('POST', '/templates', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'hash_required' });
  }
  const put = await api.call('PUT', '/templates/shipping_update/ar', draftBody());
  expect(put.status).toBe(400);
  expect(await put.json()).toEqual({ error: 'invalid_request', message: 'hash_required' });
  expect((await api.call('POST', '/templates', { ...draftBody(), expectedHash: 'not-a-hash' })).status).toBe(400);
  expect(graph.calls.filter((c) => c.url.includes('message_templates'))).toEqual([]);
  expect(await rows(W(120), 'SELECT 1 FROM templates')).toEqual([]);
});

it('Meta rejecting a submission surfaces as 400 with its message, and stores nothing', async () => {
  const api = await apiFor(W(103));
  graph = graphStub((c) => (c.method === 'GET' ? { status: 200, json: { data: [] } } : { status: 400, json: { error: { code: 100, message: 'Invalid parameter' } } }));
  const res = await api.call('POST', '/templates', await signed(api, draftBody({ name: 'dup' })));
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'invalid_request', message: 'Invalid parameter' });
  expect(await rows(W(103), 'SELECT 1 FROM templates')).toEqual([]);
});

/** The draft plus the hash the last `check` answered: what the screen sends after the merchant confirmed the preview. */
async function signed(api: Awaited<ReturnType<typeof apiFor>>, body: Record<string, unknown>) {
  const r = (await (await api.call('POST', '/templates/check', body)).json()) as { payloadHash: string };
  return { ...body, expectedHash: r.payloadHash };
}

it('install-defaults submits only the Ebda templates that are missing', async () => {
  const api = await apiFor(W(104));
  await exec(W(104), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('order_confirmation', 'ar', 'UTILITY', 'APPROVED', '[]', 1)");
  graph = graphStub(() => ({ status: 200, json: { id: '9', status: 'PENDING' } }));
  const res = await api.call('POST', '/templates/install-defaults');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ submitted: ['cod_confirmation', 'shipping_update', 'otp_code', 'cart_recovery', 'shipping_tracking', 'handoff_alert', 'handoff_alert', 'shipping_status'], skipped: ['order_confirmation'], failed: [] });
  expect(EBDA_DEFAULT_TEMPLATES.map((t) => t.name)).toEqual(['order_confirmation', 'cod_confirmation', 'shipping_update', 'otp_code', 'cart_recovery', 'shipping_tracking', 'handoff_alert', 'handoff_alert', 'shipping_status']);
});

it('refuses a send whose parameter count does not match', async () => {
  const api = await apiFor(W(105));
  const conv = await openChat(W(105));
  await exec(W(105), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('t', 'ar', 'UTILITY', 'APPROVED', ?, 1)", JSON.stringify([{ type: 'BODY', text: '{{1}} و {{2}}' }]));
  const res = await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: CLIENT, name: 't', language: 'ar', params: ['واحد'] });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: 'invalid_request', message: expect.stringContaining('needs 2 parameters') });
});

it('refuses rejected and paused templates', async () => {
  const api = await apiFor(W(106));
  const conv = await openChat(W(106));
  await exec(W(106), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('r', 'ar', 'UTILITY', 'REJECTED', '[]', 1), ('p', 'ar', 'UTILITY', 'PAUSED', '[]', 1)");
  for (const [i, name] of ['r', 'p'].entries()) {
    const res = await api.call('POST', `/conversations/${conv}/messages`, { type: 'template', clientId: `00000000-0000-4000-8000-0000000000b${i}`, name, language: 'ar', params: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'template_not_approved' });
  }
});

it('a template-status webhook updates the stored status and reason', async () => {
  await seedNumber('pn-tw', W(107), 'active', 'waba-tw');
  await exec(W(107), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('w', 'ar', 'UTILITY', 'PENDING', '[]', 1)");
  expect((await postWebhook(SELF, templateStatusPayload('waba-tw', { event: 'APPROVED', name: 'w', language: 'ar' }))).status).toBe(200);
  expect(await rows(W(107), 'SELECT status, rejected_reason FROM templates')).toEqual([{ status: 'APPROVED', rejected_reason: null }]);
  await postWebhook(SELF, templateStatusPayload('waba-tw', { event: 'REJECTED', name: 'w', language: 'ar', reason: 'INVALID_FORMAT' }));
  expect(await rows(W(107), 'SELECT status, rejected_reason FROM templates')).toEqual([{ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }]);
  await postWebhook(SELF, templateStatusPayload('waba-tw', { event: 'APPROVED', name: 'unknown', language: 'ar' })); // unknown template: ignored, still 200
});

it('renderTemplate: header formats, URL button placeholders, OTP templates, parameter hygiene', () => {
  const t = comps([
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'أهلاً {{1}}، طلب {{2}}' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'تمام' }, { type: 'URL', text: 'تتبع', url: 'https://t.example/{{1}}' }] },
  ]);
  expect(paramCount(t, 'UTILITY')).toBe(4);
  const ok = renderTemplate(t, ['https://img.example/a.png', 'أحمد', '#1', 'abc123'], 'UTILITY');
  expect(ok).toEqual({
    ok: true,
    text: 'أهلاً أحمد، طلب #1',
    components: [
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://img.example/a.png' } }] },
      { type: 'body', parameters: [{ type: 'text', text: 'أحمد' }, { type: 'text', text: '#1' }] },
      { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'abc123' }] },
    ],
  });
  expect(renderTemplate(t, ['http://insecure/a.png', 'a', 'b', 'c'], 'UTILITY')).toMatchObject({ ok: false });
  expect(renderTemplate(t, ['https://i/a.png', 'سطر\nجديد', 'b', 'c'], 'UTILITY')).toMatchObject({ ok: false });
  expect(renderTemplate(t, ['https://i/a.png', 'a', 'b', 'c d'], 'UTILITY')).toMatchObject({ ok: false });
  expect(renderTemplate(comps([{ type: 'BODY', text: 'x {{1}}' }]), ['a    b'], 'UTILITY')).toMatchObject({ ok: false });
  const otp = comps([{ type: 'BODY', add_security_recommendation: true }, { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'copy' }] }]);
  expect(paramCount(otp, 'AUTHENTICATION')).toBe(1);
  expect(renderTemplate(otp, ['482913'], 'AUTHENTICATION')).toEqual({
    ok: true,
    text: '••••••',
    components: [{ type: 'body', parameters: [{ type: 'text', text: '482913' }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] }],
  });
});

// ---- merchant self-service routes (plan 2, task 5) ----
const draftBody = (over: Record<string, unknown> = {}) => ({
  name: 'shipping_update', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] }, footer: null, buttons: [], ...over,
});

it('POST /templates/check returns issues and a hash, never calls Graph, and staff may use it', async () => {
  const staff = await apiFor(W(110), 'staff');
  graph = graphStub(() => ({ status: 200, json: {} }));
  const res = await staff.call('POST', '/templates/check', draftBody({ body: { text: '{{1}} أهلاً', examples: ['x'] } }));
  expect(res.status).toBe(200);
  const j = (await res.json()) as { issues: { code: string }[]; payloadHash: string };
  expect(j.issues.map((i) => i.code)).toContain('variable_at_edge');
  expect(j.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  expect(graph.calls.filter((c) => c.url.includes('message_templates'))).toEqual([]);
  expect((await staff.call('POST', '/templates/check', { nope: 1 })).status).toBe(400);
});

it('POST /templates with the draft body submits and answers 201 with the confirmed category', async () => {
  const api = await apiFor(W(111));
  graph = graphStub(() => ({ status: 200, json: { id: 'm-1', status: 'PENDING', category: 'MARKETING' } }));
  const res = await api.call('POST', '/templates', await signed(api, draftBody()));
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ name: 'shipping_update', language: 'ar', status: 'PENDING', category: 'MARKETING', categoryChanged: true });
  expect(graph.calls[0]!.body.components[0]).toMatchObject({ type: 'BODY', example: { body_text: [['أحمد', '1001', 'يومين']] } });
  const dup = await api.call('POST', '/templates', await signed(api, draftBody()));
  expect(dup.status).toBe(409);
  const bad = await api.call('POST', '/templates', await signed(api, draftBody({ name: 'other_one', body: { text: '{{1}} أهلاً', examples: ['x'] } })));
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: 'invalid_request', issues: [{ code: 'variable_at_edge' }] });
  const stale = await api.call('POST', '/templates', { ...draftBody({ name: 'third_one', body: { text: 'أهلاً {{1}}، شحنتك {{2}} وصلت اليوم.', examples: ['أحمد', '1001'] } }), expectedHash: 'a'.repeat(64) });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ message: 'payload_changed' });
});

it('staff may read but not create, edit or delete; no integrator write', async () => {
  const staff = await apiFor(W(112), 'staff');
  expect((await staff.call('GET', '/templates')).status).toBe(200);
  const hashed = { ...draftBody(), expectedHash: 'a'.repeat(64) };
  expect((await staff.call('POST', '/templates', hashed)).status).toBe(403);
  expect((await staff.call('PUT', '/templates/shipping_update/ar', hashed)).status).toBe(403);
  expect((await staff.call('DELETE', '/templates/shipping_update/ar')).status).toBe(403);
  expect((await staff.call('POST', '/templates/install-defaults')).status).toBe(403);
});

it('PUT within 24 h of the last edit is 409 with retryAt; a REJECTED one is edited', async () => {
  const api = await apiFor(W(113));
  await exec(W(113), "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id) VALUES ('shipping_update', 'ar', 'UTILITY', 'APPROVED', '[]', 1, 'm-9')");
  const at = Date.now() - 5_000;
  await exec(W(113), 'INSERT INTO template_edits (name, language, at) VALUES (?, ?, ?)', 'shipping_update', 'ar', at);
  graph = graphStub(() => ({ status: 200, json: { success: true } }));
  const res = await api.call('PUT', '/templates/shipping_update/ar', await signed(api, draftBody()));
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: 'invalid_request', message: 'edit_limit', retryAt: at + 86_400_000 });
  await exec(W(113), "UPDATE templates SET status = 'REJECTED'");
  const ok = await api.call('PUT', '/templates/shipping_update/ar', await signed(api, draftBody()));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ status: 'PENDING' });
  expect((await api.call('PUT', '/templates/shipping_update/en', await signed(api, draftBody()))).status).toBe(400); // url and body must agree
});

it('DELETE: in use is 409, ok is 204 and the row is gone, unknown is 404', async () => {
  const api = await apiFor(W(114));
  await exec(W(114), "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', ?, 1, 'm-5')", JSON.stringify([{ type: 'BODY', text: 'أهلاً {{1}} عرض {{2}} الليلة.' }]));
  await seedContacts(W(114), 1);
  await makeCampaign(W(114));
  graph = graphStub(() => ({ status: 200, json: { success: true } }));
  const busy = await api.call('DELETE', '/templates/promo/ar');
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ message: 'in_use' });
  await exec(W(114), "UPDATE campaigns SET status = 'completed'");
  expect((await api.call('DELETE', '/templates/promo/ar')).status).toBe(204);
  expect(await rows(W(114), 'SELECT 1 FROM templates')).toEqual([]);
  expect((await api.call('DELETE', '/templates/promo/ar')).status).toBe(404);
  expect(graph.calls.find((c) => c.method === 'DELETE')!.url).toContain('hsm_id=m-5');
});

it('GET /templates/:name/:language returns the detail with components and the edit allowance, without Meta ids', async () => {
  const api = await apiFor(W(115));
  await exec(W(115), "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id, label) VALUES ('d', 'ar', 'UTILITY', 'REJECTED', ?, 1, 'secret-id', 'قالبي')", JSON.stringify([{ type: 'BODY', text: 'أهلاً {{1}} طلبك.' }]));
  const res = await api.call('GET', '/templates/d/ar');
  expect(res.status).toBe(200);
  const j = (await res.json()) as Record<string, unknown>;
  expect(j).toMatchObject({ name: 'd', label: 'قالبي', status: 'REJECTED', editAllowance: { allowed: true }, components: [{ type: 'BODY' }] });
  expect(j).not.toHaveProperty('metaId');
  expect((await api.call('GET', '/templates/zzz/ar')).status).toBe(404);
});

it('a store with no active number gets 404 no_active_number on every template route', async () => {
  const id = W(116);
  await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(id, id, Date.now()).run();
  const api = await apiFor(W(117)); // a signed-in owner of another store cannot be used: build a token for the empty one
  void api;
  const token = await tokenFor(id, 600);
  const call = (method: string, path: string, body?: unknown) => SELF.fetch(`https://x/api/v1/stores/${id}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const [m, p, b] of [['GET', '/templates'], ['POST', '/templates/sync'], ['POST', '/templates', { ...draftBody(), expectedHash: 'a'.repeat(64) }], ['POST', '/templates/check', draftBody()], ['DELETE', '/templates/x/ar']] as [string, string, unknown?][]) {
    const res = await call(m, p, b);
    expect(res.status, `${m} ${p}`).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'no_active_number' });
  }
});
