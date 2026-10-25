import { SELF, env, listDurableObjectIds } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { rows, seedNumber, workspace } from './helpers/workspace';

type MessageRow = { wamid: string; direction: string; type: string; preview: string | null; body_r2_key: string | null };

it('stores inbound text in the workspace that owns the number', async () => {
  await seedNumber('pn-own', 'ws-own');
  const r = await postWebhook(SELF, inboundPayload('pn-own', [{ id: 'wamid.own1', text: 'hello' }]));
  expect(r.status).toBe(200);
  const msgs = await rows<MessageRow>('ws-own', 'SELECT wamid, direction, type, preview FROM messages');
  expect(msgs).toEqual([{ wamid: 'wamid.own1', direction: 'in', type: 'text', preview: 'hello' }]);
  const contacts = await rows('ws-own', 'SELECT wa_id, profile_name FROM contacts');
  expect(contacts).toEqual([{ wa_id: '201001234567', profile_name: 'Ahmad' }]);
});

it('stores a duplicate inbound delivery once', async () => {
  await seedNumber('pn-dup', 'ws-dup');
  const body = inboundPayload('pn-dup', [{ id: 'wamid.dup1' }]);
  await postWebhook(SELF, body);
  await postWebhook(SELF, body);
  expect(await rows('ws-dup', 'SELECT id FROM messages')).toHaveLength(1);
});

it('returns one reply job per new inbound text', async () => {
  const batch = { phoneNumberId: 'pn-rep', inbound: [{ wamid: 'wamid.r1', from: '201001234567', ts: 1, type: 'text' as const, text: 'x' }], statuses: [], receivedAt: 1 };
  const cfg = { autoReplyText: 'reply' };
  const first = await workspace('ws-rep').ingest(batch, cfg);
  const second = await workspace('ws-rep').ingest(batch, cfg);
  expect(first.replies.map((j) => j.idempotencyKey)).toEqual(['reply:wamid.r1']);
  expect(first.replies[0]).toMatchObject({ workspaceId: 'ws-rep', phoneNumberId: 'pn-rep', to: '201001234567' });
  expect(second).toMatchObject({ stored: 0, duplicates: 1 });
});

it('acknowledges and drops a webhook for an unknown phone_number_id', async () => {
  const before = (await listDurableObjectIds(env.WORKSPACE_DO)).length;
  const r = await postWebhook(SELF, inboundPayload('pn-nobody', [{ id: 'wamid.x' }]));
  expect(r.status).toBe(200);
  expect((await listDurableObjectIds(env.WORKSPACE_DO)).length).toBe(before);
});

it('treats a disconnected number as unknown', async () => {
  await seedNumber('pn-off', 'ws-off', 'disconnected');
  const before = (await listDurableObjectIds(env.WORKSPACE_DO)).length;
  expect((await postWebhook(SELF, inboundPayload('pn-off', [{ id: 'wamid.off' }]))).status).toBe(200);
  expect((await listDurableObjectIds(env.WORKSPACE_DO)).length).toBe(before);
});

it('round-trips Arabic and emoji text', async () => {
  await seedNumber('pn-ar', 'ws-ar');
  const text = 'عايز أطلب ٢ تيشيرت 👕';
  await postWebhook(SELF, inboundPayload('pn-ar', [{ id: 'wamid.ar1', text }]));
  const [m] = await rows<MessageRow>('ws-ar', 'SELECT preview FROM messages');
  expect(m?.preview).toBe(text);
});

it('moves a body over 1 KB to R2 and keeps a 280-character preview', async () => {
  await seedNumber('pn-big', 'ws-big');
  const text = 'ب'.repeat(1200);
  await postWebhook(SELF, inboundPayload('pn-big', [{ id: 'wamid.big1', text }]));
  const [m] = await rows<MessageRow>('ws-big', 'SELECT preview, body_r2_key FROM messages');
  expect(m?.preview).toHaveLength(280);
  expect(m?.body_r2_key).toBeTruthy();
  expect(await (await env.MEDIA.get(m!.body_r2_key!))?.text()).toBe(text);
});

it('stores a non-text message by type', async () => {
  // The image schedules a media download: answer it here and run it now, so it cannot fire (unstubbed) during a later test.
  stubGraph((c) => c.url.includes('lookaside') ? { status: 200, body: 'img' } : { status: 200, json: { url: 'https://lookaside.fbsbx.com/m1', mime_type: 'image/jpeg', file_size: 3 } });
  await seedNumber('pn-img', 'ws-img');
  await postWebhook(SELF, inboundPayload('pn-img', [{ id: 'wamid.img1', type: 'image' }]));
  await workspace('ws-img').runDueTasks();
  expect(await rows('ws-img', 'SELECT type FROM messages')).toEqual([{ type: 'image' }]);
});

it('answers 200 to a malformed payload, never a 500', async () => {
  expect((await postWebhook(SELF, '{"object":"whatsapp_business_account","entry":"nope"}')).status).toBe(200);
  expect((await postWebhook(SELF, 'not json')).status).toBe(200);
});
