import { SELF } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { listTemplatesResponse } from '../src/core/api/contract';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { componentsSchema, paramCount, renderTemplate } from '../src/core/templates';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
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
  const body = { name: 'shipping_update', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'شحنتك {{1}} خرجت', example: { body_text: [['1001']] } }] };
  const res = await api.call('POST', '/templates', body);
  expect(res.status).toBe(201);
  expect(graph.calls[0]!.url).toBe('https://graph.facebook.com/v25.0/waba-1/message_templates');
  expect(graph.calls[0]!.body).toEqual(body);
  expect(await rows(W(102), 'SELECT name, status FROM templates')).toEqual([{ name: 'shipping_update', status: 'PENDING' }]);
  const staff = await apiFor(W(102), 'staff');
  expect((await staff.call('POST', '/templates', body)).status).toBe(403);
  expect((await api.call('POST', '/templates', { ...body, name: 'Bad Name!' })).status).toBe(400);
});

it('Meta rejecting a submission surfaces as 400 with its message, and stores nothing', async () => {
  const api = await apiFor(W(103));
  graph = graphStub(() => ({ status: 400, json: { error: { code: 100, message: 'Template name already exists' } } }));
  const res = await api.call('POST', '/templates', { name: 'dup', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'invalid_request', message: 'Template name already exists' });
  expect(await rows(W(103), 'SELECT 1 FROM templates')).toEqual([]);
});

it('install-defaults submits only the Ebda templates that are missing', async () => {
  const api = await apiFor(W(104));
  await exec(W(104), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('order_confirmation', 'ar', 'UTILITY', 'APPROVED', '[]', 1)");
  graph = graphStub(() => ({ status: 200, json: { id: '9', status: 'PENDING' } }));
  const res = await api.call('POST', '/templates/install-defaults');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ submitted: ['cod_confirmation', 'shipping_update', 'otp_code', 'cart_recovery', 'shipping_tracking', 'shipping_status'], skipped: ['order_confirmation'], failed: [] });
  expect(EBDA_DEFAULT_TEMPLATES.map((t) => t.name)).toEqual(['order_confirmation', 'cod_confirmation', 'shipping_update', 'otp_code', 'cart_recovery', 'shipping_tracking', 'shipping_status']);
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
