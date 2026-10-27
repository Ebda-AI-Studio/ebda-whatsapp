import { SELF, env } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { eventsResponse, messageDto } from '../src/core/api/contract';
import type { SendJob } from '../src/core/send-queue';
import { apiFor, graphStub, storeId as W, useApiKey } from './helpers/api';
import { postWebhook } from './helpers/meta';
import { inboundPayload } from './helpers/payload';
import { exec, openChat, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const bytesOf = (head: number[] | string, pad = 24) => new Uint8Array([...(typeof head === 'string' ? [...head].map((c) => c.charCodeAt(0)) : head), ...new Array(pad).fill(1)]);
const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = bytesOf('%PDF-1.7\n');
const OGG_OPUS = bytesOf('OggS\0\x02\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x01\x13OpusHead');
const MP4 = bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const HTML = bytesOf('<html><script>alert(1)</script>');
const mediaReplies = (id: string, mime = 'image/jpeg') => (c: { url: string }) =>
  c.url.endsWith(`/${id}`)
    ? { status: 200, json: { url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${id}`, mime_type: mime, file_size: JPEG.byteLength } }
    : { status: 200, body: JPEG, headers: { 'content-type': mime } };

async function inboundImage(store: string, pn: string, wamid: string, mediaId: string, extra: Record<string, unknown> = {}) {
  await seedNumber(pn, store);
  const ts = Math.floor(Date.now() / 1000);
  expect((await postWebhook(SELF, inboundPayload(pn, [{ id: wamid, type: 'image', ts, mediaId, ...extra }]))).status).toBe(200);
  return (await rows<{ id: number; conversation_id: number }>(store, 'SELECT id, conversation_id FROM messages WHERE wamid = ?', wamid))[0]!;
}

it('stores an inbound image in R2 (never the expiring Meta URL) and serves it after auth', async () => {
  const store = W(400);
  const api = await apiFor(store, 'owner', 'pn-m1');
  // The stub goes in first: the DO's own alarm may also run the download task, and must see the same Meta.
  const g = graphStub(mediaReplies('media-m1'));
  const msg = await inboundImage(store, 'pn-m1', 'wamid.m1', 'media-m1', { caption: 'شوف الصورة' });
  // the caption is the text right away; the R2 key appears only once the download task has run (the DO's own alarm
  // may already have run it, so the key is not asserted before runDueTasks)
  expect(await rows(store, 'SELECT type, preview, media_mime FROM messages WHERE id = ?', msg.id)).toEqual([{ type: 'image', preview: 'شوف الصورة', media_mime: 'image/jpeg' }]);
  expect(await workspace(store).runDueTasks(Date.now() + 1000)).toMatchObject({ failed: 0 });
  expect(await rows(store, 'SELECT media_r2_key FROM messages WHERE id = ?', msg.id)).toEqual([{ media_r2_key: `media/${store}/wamid.m1` }]);
  expect(g.calls.map((c) => c.url)).toEqual([
    'https://graph.facebook.com/v25.0/media-m1',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=media-m1',
  ]);
  expect(g.calls.every((c) => c.headers.authorization === 'Bearer test-token')).toBe(true);
  expect(new Uint8Array(await (await env.MEDIA.get(`media/${store}/wamid.m1`))!.arrayBuffer())).toEqual(JPEG);

  const after = messageDto.parse(((await (await api.call('GET', `/conversations/${msg.conversation_id}/messages`)).json()) as { items: unknown[] }).items[0]);
  expect(after.media).toEqual({ mime: 'image/jpeg', size: JPEG.byteLength, url: `/api/v1/stores/${store}/media/${msg.id}` });
  const res = await api.call('GET', `/media/${msg.id}`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toContain("sandbox");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG);
  // the UI is told when the media becomes ready (message.created is re-sent for the same message id)
  const events = eventsResponse.parse(await (await api.call('GET', '/events?after=0')).json()).items;
  const created = events.filter((e) => e.type === 'message.created' && e.message.id === msg.id);
  expect(created).toHaveLength(2);
  expect(created.at(-1)).toMatchObject({ message: { media: { mime: 'image/jpeg' } } });
});

it('serves byte ranges so audio and video can seek', async () => {
  const store = W(401);
  const api = await apiFor(store, 'owner', 'pn-m2');
  graphStub(mediaReplies('media-m2'));
  const msg = await inboundImage(store, 'pn-m2', 'wamid.m2', 'media-m2');
  await workspace(store).runDueTasks(Date.now() + 1000);
  const res = await api.call('GET', `/media/${msg.id}`, undefined, { range: 'bytes=2-4' });
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe(`bytes 2-4/${JPEG.byteLength}`);
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG.slice(2, 5));
});

it('retries a failed download with backoff and gives up after 8 tries without losing the message', { timeout: 20_000 }, async () => {
  const store = W(402);
  await apiFor(store, 'owner', 'pn-m3');
  const g = graphStub(() => ({ status: 500, json: { error: { message: 'boom' } } }));
  const msg = await inboundImage(store, 'pn-m3', 'wamid.m3', 'media-m3');
  const ws = workspace(store);
  // Whoever runs it (the DO's alarm or this loop), every try fails at the Meta lookup: exactly 8 tries, then it is abandoned.
  let now = Date.now() + 1000;
  for (let i = 0; i < 10; i++) { await ws.runDueTasks(now); now += 3_700_000; }
  expect(g.calls).toHaveLength(8);
  expect(await rows(store, "SELECT 1 FROM scheduled_tasks WHERE kind = 'media_fetch'")).toEqual([]); // abandoned, loudly
  expect(await rows(store, 'SELECT media_r2_key FROM messages WHERE id = ?', msg.id)).toEqual([{ media_r2_key: null }]);
});

it('does not download media for a duplicate delivery', async () => {
  const store = W(403);
  await apiFor(store, 'owner', 'pn-m4');
  const g = graphStub();
  await inboundImage(store, 'pn-m4', 'wamid.m4', 'media-m4');
  await inboundImage(store, 'pn-m4', 'wamid.m4', 'media-m4');
  await workspace(store).runDueTasks();
  expect(g.calls.filter((c) => c.url.startsWith('https://graph.facebook.com/') && c.url.endsWith('/media-m4'))).toHaveLength(1); // one lookup for two deliveries
});

function upload(name: string, type: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set('file', new File([bytes], name, { type }));
  return form;
}

it('uploads an allowed file to Meta, keeps a copy, and the later send serves it back', async () => {
  const store = W(404);
  const api = await apiFor(store, 'owner', 'pn-m5');
  const conv = await openChat(store);
  const g = graphStub((c) => (c.url.endsWith('/pn-m5/media') ? { status: 200, json: { id: 'meta-media-1' } } : { status: 200, json: { messages: [{ id: 'wamid.outm' }] } }));
  const res = await api.call('POST', '/media', upload('صورة.jpg', 'image/jpeg', JPEG));
  expect(res.status).toBe(201);
  const up = (await res.json()) as { uploadId: string; mime: string; size: number; filename: string };
  expect(up).toMatchObject({ mime: 'image/jpeg', size: JPEG.byteLength, filename: 'صورة.jpg' });
  expect(g.calls[0]!.url).toBe('https://graph.facebook.com/v25.0/pn-m5/media');
  const sent = g.calls[0]!.body as FormData;
  expect(sent.get('messaging_product')).toBe('whatsapp');
  expect(sent.get('type')).toBe('image/jpeg');
  expect((sent.get('file') as File).size).toBe(JPEG.byteLength);

  const post = await api.call('POST', `/conversations/${conv}/messages`, { type: 'media', clientId: '00000000-0000-4000-8000-000000000404', uploadId: up.uploadId, caption: 'تفضل' });
  expect(post.status).toBe(202);
  const dto = messageDto.parse(await post.json());
  expect(dto).toMatchObject({ type: 'image', text: 'تفضل', media: { mime: 'image/jpeg' } });
  const job = (vi.mocked(env.SEND_QUEUE.sendBatch).mock.calls.at(-1)![0] as { body: SendJob }[])[0]!.body;
  expect(job.media).toEqual({ kind: 'image', mediaId: 'meta-media-1', caption: 'تفضل', filename: 'صورة.jpg' });
  const back = await api.call('GET', `/media/${dto.id}`);
  expect(back.status).toBe(200);
  expect(new Uint8Array(await back.arrayBuffer())).toEqual(JPEG);
});

it('refuses types outside the allow-list with unsupported_media and files over the size cap', async () => {
  const store = W(405);
  const api = await apiFor(store, 'owner', 'pn-m6');
  const g = graphStub();
  for (const [name, type] of [['a.gif', 'image/gif'], ['a.svg', 'image/svg+xml'], ['a.html', 'text/html'], ['a.webp', 'image/webp'], ['a.exe', 'application/octet-stream']] as const) {
    const res = await api.call('POST', '/media', upload(name, type, JPEG));
    expect(res.status, type).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media' });
  }
  const big = await api.call('POST', '/media', upload('big.jpg', 'image/jpeg', new Uint8Array(5 * 1024 * 1024 + 1)));
  expect(big.status).toBe(413);
  expect((await api.call('POST', '/media', undefined)).status).toBe(411);
  expect((await api.call('POST', '/media', { not: 'form' })).status).toBe(415); // JSON on an upload route: refused by the content-type allow-list
  expect(g.calls).toHaveLength(0); // nothing reached Meta
  // the ogg/opus parameter is accepted in either spelling
  g.restore();
  graphStub(() => ({ status: 200, json: { id: 'meta-ogg' } }));
  expect((await api.call('POST', '/media', upload('v.ogg', 'audio/ogg;codecs=opus', OGG_OPUS))).status).toBe(201);
});

it('a Meta upload failure is reported and stores nothing', async () => {
  const store = W(406);
  const api = await apiFor(store, 'owner', 'pn-m7');
  graphStub(() => ({ status: 400, json: { error: { code: 131053, message: 'Media upload error' } } }));
  const res = await api.call('POST', '/media', upload('a.jpg', 'image/jpeg', JPEG));
  expect(res.status).toBe(400);
  expect(await rows(store, 'SELECT 1 FROM uploads')).toEqual([]);
});

it('a media send for an unknown upload is invalid_request, and a bad mime in the table is unsupported_media', async () => {
  const store = W(407);
  const api = await apiFor(store, 'owner', 'pn-m8');
  const conv = await openChat(store);
  const res = await api.call('POST', `/conversations/${conv}/messages`, { type: 'media', clientId: '00000000-0000-4000-8000-000000000407', uploadId: 'nope' });
  expect(res.status).toBe(400);
  await exec(store, "INSERT INTO uploads (id, meta_media_id, mime, size, filename, r2_key, created_at) VALUES ('bad', 'm', 'text/html', 1, 'a.html', 'uploads/x', 1)");
  const bad = await api.call('POST', `/conversations/${conv}/messages`, { type: 'media', clientId: '00000000-0000-4000-8000-000000000408', uploadId: 'bad' });
  expect(bad.status).toBe(415);
});

it('erasing a contact deletes their media from R2', async () => {
  const store = W(408);
  await apiFor(store, 'owner', 'pn-m9');
  graphStub(mediaReplies('media-m9'));
  await inboundImage(store, 'pn-m9', 'wamid.m9', 'media-m9');
  await workspace(store).runDueTasks(Date.now() + 1000);
  expect(await env.MEDIA.get(`media/${store}/wamid.m9`)).not.toBeNull();
  const r = await workspace(store).eraseContact('201001234567');
  expect(r).toMatchObject({ found: true, r2Pending: 0 });
  expect(await env.MEDIA.get(`media/${store}/wamid.m9`)).toBeNull();
});

it('overlapping task runs never execute the same task twice (lease)', async () => {
  const store = W(409);
  await apiFor(store, 'owner', 'pn-lease');
  const g = graphStub(() => ({ status: 500, json: { error: { message: 'boom' } } }), 20);
  await inboundImage(store, 'pn-lease', 'wamid.lease', 'media-lease');
  const ws = workspace(store);
  const now = Date.now() + 1000;
  await Promise.all([ws.runDueTasks(now), ws.runDueTasks(now), ws.runDueTasks(now)]);
  // one attempt only (then backoff), however many runners overlapped — the DO's own alarm included
  // the winner may be the DO's own alarm, still finishing its attempt: wait for the attempt to be recorded
  await vi.waitFor(async () => expect(await rows(store, "SELECT attempts FROM scheduled_tasks WHERE kind = 'media_fetch'")).toEqual([{ attempts: 1 }]));
  expect(g.calls.length).toBe(1);
});

it('an mp4 is recognised by its ftyp brand: mov, m4a and heic are not mp4', async () => {
  const { sniffMime } = await import('../src/core/media');
  const brand = (b: string) => bytesOf([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...b].map((c) => c.charCodeAt(0))]);
  for (const ok of ['isom', 'mp42', 'avc1']) expect(sniffMime(brand(ok)), ok).toBe('video/mp4');
  for (const no of ['qt  ', 'M4A ', 'heic']) expect(sniffMime(brand(no)), no).toBeNull();
});

// M-134: the bytes decide, not the declared type.
it('sniffs the real type from the bytes: a file whose bytes do not match its declared type is unsupported_media and never reaches Meta', async () => {
  const store = W(407);
  const api = await apiFor(store, 'owner', 'pn-m8');
  const g = graphStub(() => ({ status: 200, json: { id: 'meta-ok' } }));
  const bad: [string, string, Uint8Array][] = [
    ['x.jpg', 'image/jpeg', HTML], ['x.png', 'image/png', JPEG], ['x.jpg', 'image/jpeg', PDF], ['x.pdf', 'application/pdf', PNG],
    ['x.mp4', 'video/mp4', JPEG], ['x.ogg', 'audio/ogg;codecs=opus', MP4], ['x.jpg', 'image/jpeg', new Uint8Array([0xff])],
  ];
  for (const [name, type, bytes] of bad) {
    const res = await api.call('POST', '/media', upload(name, type, bytes));
    expect(res.status, `${type} / ${name}`).toBe(415);
    expect(await res.json()).toMatchObject({ error: 'unsupported_media' });
  }
  expect(g.calls).toHaveLength(0);
  for (const [name, type, bytes] of [['a.jpg', 'image/jpeg', JPEG], ['a.png', 'image/png', PNG], ['a.pdf', 'application/pdf', PDF], ['a.ogg', 'audio/ogg; codecs=opus', OGG_OPUS], ['a.mp4', 'video/mp4', MP4]] as const) {
    expect((await api.call('POST', '/media', upload(name, type, bytes))).status, type).toBe(201);
  }
});
