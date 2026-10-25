import { env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { messageDto as messageDtoSchema, type MessageDto } from '../src/core/api/contract';
import type { SendJob } from '../src/core/send-queue';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import type { stubGraph } from './helpers/graph';
import { consume } from './helpers/queue';
import { exec, openChat, rows } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => graph?.restore());

const CLIENT = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const queued = () => vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.flatMap((c) => (c[0] as { body: SendJob }[]).map((m) => m.body));

async function setup(ws: string) {
  const api = await apiFor(ws);
  const convId = await openChat(ws);
  return { api, convId, post: (body: unknown) => api.call('POST', `/conversations/${convId}/messages`, body) };
}

it('202 with a queued MessageDto and one SendJob keyed by clientId', async () => {
  const { post } = await setup(W(1));
  const res = await post({ type: 'text', clientId: CLIENT(1), text: 'أهلاً بيك' });
  expect(res.status).toBe(202);
  const dto = messageDtoSchema.parse(await res.json());
  expect(dto).toMatchObject({ clientId: CLIENT(1), direction: 'out', type: 'text', text: 'أهلاً بيك', status: 'queued', wamid: null });
  const jobs = queued();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ workspaceId: W(1), phoneNumberId: `pn-${W(1)}`, to: '201001234567', kind: 'text', text: 'أهلاً بيك', idempotencyKey: `ui:${CLIENT(1)}` });
});

it('a duplicate clientId sends once and returns the same message', async () => {
  const { post } = await setup(W(2));
  const a = (await (await post({ type: 'text', clientId: CLIENT(2), text: 'x' })).json()) as MessageDto;
  const res = await post({ type: 'text', clientId: CLIENT(2), text: 'x' });
  expect(res.status).toBe(202);
  expect(((await res.json()) as MessageDto).id).toBe(a.id);
  expect(queued()).toHaveLength(1);
  expect(await rows(W(2), "SELECT 1 FROM messages WHERE direction = 'out'")).toHaveLength(1);
});

it('each type reaches Meta with the exact Graph body', async () => {
  const { post, api } = await setup(W(3));
  await exec(W(3), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('order_confirmation', 'ar', 'UTILITY', 'APPROVED', ?, 1)",
    JSON.stringify([{ type: 'BODY', text: 'أهلاً {{1}}، طلبك {{2}} اتأكد' }]));
  await exec(W(3), "INSERT INTO uploads (id, meta_media_id, mime, size, filename, r2_key, created_at) VALUES ('up1', 'media-77', 'image/jpeg', 10, 'a.jpg', 'uploads/x/up1', 1)");
  for (const [i, body] of [
    { type: 'text', clientId: CLIENT(10), text: 'hello' },
    { type: 'template', clientId: CLIENT(11), name: 'order_confirmation', language: 'ar', params: ['أحمد', '#1001'] },
    { type: 'interactive', clientId: CLIENT(12), body: 'تأكد الطلب؟', buttons: [{ id: 'yes', title: 'أيوه' }, { id: 'no', title: 'لا' }] },
    { type: 'media', clientId: CLIENT(13), uploadId: 'up1', caption: 'صورة' },
  ].entries()) {
    const res = await post(body);
    expect(res.status, `type ${i}`).toBe(202);
  }
  graph = graphStub();
  const res = await consume(queued());
  expect(res.explicitAcks).toHaveLength(4);
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: '201001234567' };
  expect(graph.calls.map((c) => c.body)).toEqual([
    { ...base, type: 'text', text: { body: 'hello' } },
    { ...base, type: 'template', template: { name: 'order_confirmation', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'أحمد' }, { type: 'text', text: '#1001' }] }] } },
    { ...base, type: 'interactive', interactive: { type: 'button', body: { text: 'تأكد الطلب؟' }, action: { buttons: [{ type: 'reply', reply: { id: 'yes', title: 'أيوه' } }, { type: 'reply', reply: { id: 'no', title: 'لا' } }] } } },
    { ...base, type: 'image', image: { id: 'media-77', caption: 'صورة' } },
  ]);
  expect(graph.calls.every((c) => c.url === `https://graph.facebook.com/v25.0/pn-${W(3)}/messages`)).toBe(true);
  expect(await rows(W(3), "SELECT type, status FROM messages WHERE direction = 'out' ORDER BY id")).toEqual([
    { type: 'text', status: 'accepted' }, { type: 'template', status: 'accepted' }, { type: 'interactive', status: 'accepted' }, { type: 'image', status: 'accepted' },
  ]);
  void api;
});

it('refuses a free-form send outside the 24 h window with window_closed (409)', async () => {
  const api = await apiFor(W(4));
  const convId = await openChat(W(4), '201001234567', { ts: Math.floor(Date.now() / 1000) - 25 * 3600 });
  for (const body of [
    { type: 'text', clientId: CLIENT(20), text: 'x' },
    { type: 'interactive', clientId: CLIENT(21), body: 'x', buttons: [{ id: 'a', title: 'a' }] },
  ]) {
    const res = await api.call('POST', `/conversations/${convId}/messages`, body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'window_closed' });
  }
  expect(queued()).toHaveLength(0);
  expect(await rows(W(4), "SELECT 1 FROM messages WHERE direction = 'out'")).toEqual([]);
});

it('a template is allowed outside the window; a marketing template to an opted-out contact is refused', async () => {
  const api = await apiFor(W(5));
  const convId = await openChat(W(5), '201001234567', { ts: Math.floor(Date.now() / 1000) - 48 * 3600 });
  await exec(W(5), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('promo', 'ar', 'MARKETING', 'APPROVED', ?, 1), ('util', 'ar', 'UTILITY', 'APPROVED', ?, 1)",
    JSON.stringify([{ type: 'BODY', text: 'عرض' }]), JSON.stringify([{ type: 'BODY', text: 'تحديث' }]));
  const send = (name: string, n: number) => api.call('POST', `/conversations/${convId}/messages`, { type: 'template', clientId: CLIENT(n), name, language: 'ar', params: [] });
  expect((await send('promo', 30)).status).toBe(202);
  await exec(W(5), 'UPDATE contacts SET opted_out_at = 1');
  const refused = await send('promo', 31);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: 'opted_out' });
  expect((await send('util', 32)).status).toBe(202); // utility passes
});

it('refuses a template that is missing, pending or rejected with template_not_approved (409)', async () => {
  const { post } = await setup(W(6));
  await exec(W(6), "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('p', 'ar', 'UTILITY', 'PENDING', '[]', 1)");
  for (const [n, name] of [[40, 'p'], [41, 'nope']] as const) {
    const res = await post({ type: 'template', clientId: CLIENT(n), name, language: 'ar', params: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'template_not_approved' });
  }
});

it('rejects a bad body with invalid_request, an unknown conversation with not_found, and marks the row failed if the enqueue throws', async () => {
  const { post, api } = await setup(W(7));
  expect((await post({ type: 'text', clientId: 'not-a-uuid', text: 'x' })).status).toBe(400);
  expect((await api.call('POST', '/conversations/99999/messages', { type: 'text', clientId: CLIENT(50), text: 'x' })).status).toBe(404);
  vi.mocked(env.SEND_QUEUE.sendBatch).mockRejectedValueOnce(new Error('queue down'));
  const res = await post({ type: 'text', clientId: CLIENT(51), text: 'x' });
  expect(res.status).toBe(503);
  expect(await rows(W(7), "SELECT status FROM messages WHERE direction = 'out'")).toEqual([{ status: 'failed' }]);
});

it('401 without a token and 403 for another store', async () => {
  const { convId } = await setup(W(8));
  const { SELF } = await import('cloudflare:test');
  const anon = await SELF.fetch(`https://x/api/v1/stores/${W(8)}/conversations/${convId}/messages`, { method: 'POST', body: '{}' });
  expect(anon.status).toBe(401);
  const other = await apiFor(W(88));
  expect((await SELF.fetch(`https://x/api/v1/stores/${W(8)}/conversations/${convId}/messages`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'text', clientId: CLIENT(60), text: 'x' }) })).status).toBe(403);
});
