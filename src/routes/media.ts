import { Hono } from 'hono';
import { canonicalMime, outboundMediaFor, safeFilename } from '../core/media';
import { activeNumber, apiError, intParam, workspaceStub, type ApiEnv } from './shared';

export const mediaRoutes = new Hono<ApiEnv>();

/** The largest allowed file plus multipart overhead; anything bigger is refused before it is read. */
const MAX_UPLOAD_BYTES = 101 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;
const INLINE_TYPES = /^(image\/(jpeg|png)|audio\/|video\/mp4|application\/pdf)/;

/** Streams a message's file from R2 after auth. Honors Range so audio and video can seek. */
mediaRoutes.get('/stores/:storeId/media/:messageId', async (c) => {
  const id = intParam(c, 'messageId');
  if (!id) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const media = ws && (await ws.getMedia(id));
  if (!media) return apiError(c, 404, 'not_found');
  const obj = await c.env.MEDIA.get(media.key, { range: c.req.raw.headers });
  if (!obj) return apiError(c, 404, 'not_found');
  const headers = new Headers({
    'content-type': media.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    // The bytes come from a customer: they may be shown but never run or framed with any privileges.
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': INLINE_TYPES.test(media.mime) ? 'inline' : 'attachment',
  });
  const r = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (r && c.req.header('range')) {
    const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - offset);
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

/** Stages a file for sending: validates type and size, uploads it to Meta, keeps a copy in R2, returns an uploadId. */
mediaRoutes.post('/stores/:storeId/media', async (c) => {
  if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) return apiError(c, 400, 'invalid_request', 'file_too_large');
  let file: unknown;
  try {
    file = (await c.req.formData()).get('file');
  } catch {
    return apiError(c, 400, 'invalid_request');
  }
  if (!(file instanceof File)) return apiError(c, 400, 'invalid_request');
  const allowed = outboundMediaFor(file.type);
  if (!allowed) return apiError(c, 415, 'unsupported_media');
  if (file.size === 0) return apiError(c, 400, 'invalid_request');
  if (file.size > allowed.maxBytes) return c.json({ error: 'invalid_request', message: 'file_too_large' }, 413);
  const ws = await workspaceStub(c);
  const number = await activeNumber(c);
  if (!ws || !number) return apiError(c, 404, 'not_found');
  const mime = canonicalMime(file.type);
  const filename = safeFilename(file.name);
  const bytes = await file.arrayBuffer();

  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', mime);
  form.set('file', new File([bytes], filename, { type: mime }));
  let metaRes: Response;
  try {
    metaRes = await fetch(`https://graph.facebook.com/${c.env.META_GRAPH_VERSION}/${number.phoneNumberId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.env.META_SYSTEM_TOKEN}` },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch {
    return apiError(c, 503, 'rate_limited', 'upload_failed');
  }
  const json = (await metaRes.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!metaRes.ok || !json?.id) {
    return metaRes.status >= 500 || metaRes.status === 429 ? apiError(c, 503, 'rate_limited', json?.error?.message) : apiError(c, 400, 'invalid_request', json?.error?.message ?? 'upload_rejected');
  }
  const uploadId = crypto.randomUUID();
  const r2Key = `uploads/${c.req.param('storeId')}/${uploadId}`;
  await c.env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: mime } });
  await ws.recordUpload({ id: uploadId, metaMediaId: json.id, mime, size: bytes.byteLength, filename, r2Key });
  return c.json({ uploadId, mime, size: bytes.byteLength, filename }, 201);
});
