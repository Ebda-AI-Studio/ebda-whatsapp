import { afterEach, expect, it } from 'vitest';
import { deleteTemplate, editTemplate, fetchTemplates, submitTemplate } from '../src/core/meta/templates-api';
import { graphStub, useApiKey } from './helpers/api';
import type { stubGraph } from './helpers/graph';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());
const A = { token: 'tok', graphVersion: 'v25.0', wabaId: 'waba-1' };

it('editTemplate posts components to /v25.0/{id} with the bearer token (Meta answers {success:true})', async () => {
  graph = graphStub(() => ({ status: 200, json: { success: true } }));
  const comps = [{ type: 'BODY', text: 'أهلاً {{1}} طلبك خرج للشحن.' }];
  const res = await editTemplate(A, 'tpl-9', { category: 'UTILITY', components: comps });
  expect(res).toEqual({ ok: true, value: { status: 'PENDING' } });
  expect(graph.calls[0]).toMatchObject({ url: 'https://graph.facebook.com/v25.0/tpl-9', method: 'POST', body: { category: 'UTILITY', components: comps } });
  expect(graph.calls[0]!.headers.authorization).toBe('Bearer tok');
});

it('deleteTemplate with metaId sends name AND hsm_id so ONE language goes; without metaId only the name', async () => {
  graph = graphStub(() => ({ status: 200, json: { success: true } }));
  expect(await deleteTemplate(A, { name: 'shipping_update', metaId: '123' })).toEqual({ ok: true, value: { deleted: true } });
  expect(graph.calls[0]).toMatchObject({ method: 'DELETE', url: 'https://graph.facebook.com/v25.0/waba-1/message_templates?name=shipping_update&hsm_id=123' });
  await deleteTemplate(A, { name: 'shipping_update' });
  expect(graph.calls[1]!.url).toBe('https://graph.facebook.com/v25.0/waba-1/message_templates?name=shipping_update');
});

it('a Graph 4xx is ok:false retryable:false with error_user_msg; 429 and 5xx are retryable', async () => {
  graph = graphStub(() => ({ status: 400, json: { error: { code: 100, message: 'Invalid parameter', error_user_msg: 'اسم القالب مستخدم' } } }));
  expect(await editTemplate(A, 't', { components: [] })).toEqual({ ok: false, message: 'اسم القالب مستخدم', retryable: false });
  expect(await deleteTemplate(A, { name: 'x' })).toMatchObject({ ok: false, retryable: false });
  graph.restore();
  graph = graphStub(() => ({ status: 429, json: { error: { message: 'slow down' } } }));
  expect(await editTemplate(A, 't', { components: [] })).toMatchObject({ ok: false, retryable: true });
  graph.restore();
  graph = graphStub(() => ({ status: 503, json: {} }));
  expect(await deleteTemplate(A, { name: 'x' })).toMatchObject({ ok: false, retryable: true });
});

it('an HTTP 200 whose body is not success:true is a failure, never a silent success', async () => {
  graph = graphStub(() => ({ status: 200, json: { error: { message: 'weird' } } }));
  expect(await editTemplate(A, 't', { components: [] })).toMatchObject({ ok: false });
  expect(await deleteTemplate(A, { name: 'x' })).toMatchObject({ ok: false });
});

it('submitTemplate returns the Meta template id; fetchTemplates asks for it and returns it', async () => {
  graph = graphStub(() => ({ status: 200, json: { id: 'tpl-1', status: 'PENDING', category: 'MARKETING' } }));
  expect(await submitTemplate(A, { name: 'n', language: 'ar', category: 'UTILITY', components: [] })).toEqual({ ok: true, value: { id: 'tpl-1', status: 'PENDING', category: 'MARKETING', categoryConfirmed: true } });
  graph.restore();
  graph = graphStub(() => ({ status: 200, json: { data: [{ id: 'tpl-2', name: 'n', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [] }] } }));
  const r = await fetchTemplates(A);
  expect(r.ok && r.value[0]!.id).toBe('tpl-2');
  expect(decodeURIComponent(graph.calls[0]!.url)).toMatch(/fields=[^&]*\bid\b/);
});
