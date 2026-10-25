/** Documents are held in Worker memory while they are forwarded to Meta (128 MB isolate), so the cap stays well under Meta's 100 MB. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
/** Multipart framing and field overhead allowed on top of the largest file. */
export const UPLOAD_OVERHEAD_BYTES = 1024 * 1024;

/** Outbound media the WhatsApp Cloud API accepts and we allow (Phase 2 plan, A8). Everything else is refused as unsupported_media. */
export const OUTBOUND_MEDIA: Readonly<Record<string, { kind: 'image' | 'audio' | 'video' | 'document'; maxBytes: number }>> = {
  'image/jpeg': { kind: 'image', maxBytes: 5 * 1024 * 1024 },
  'image/png': { kind: 'image', maxBytes: 5 * 1024 * 1024 },
  'audio/ogg;codecs=opus': { kind: 'audio', maxBytes: 16 * 1024 * 1024 },
  'video/mp4': { kind: 'video', maxBytes: 16 * 1024 * 1024 },
  'application/pdf': { kind: 'document', maxBytes: MAX_DOCUMENT_BYTES },
};

/** Lower-cases and removes spaces so `audio/ogg; codecs=opus` and `Audio/OGG;codecs=opus` compare equal. */
export const normaliseMime = (mime: string): string => mime.toLowerCase().replace(/\s+/g, '');

export function outboundMediaFor(mime: string) {
  return OUTBOUND_MEDIA[normaliseMime(mime)] ?? null;
}

/** The spelling Meta documents for the allowed types (it wants "audio/ogg; codecs=opus" with the space). */
export const canonicalMime = (mime: string): string => (normaliseMime(mime) === 'audio/ogg;codecs=opus' ? 'audio/ogg; codecs=opus' : normaliseMime(mime));

/** Strips path separators and control characters from a client-supplied file name. */
export const safeFilename = (name: string): string => name.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 120) || 'file';

export const MEDIA_FETCH_MAX_ATTEMPTS = 8;
const BUFFER_LIMIT = 16 * 1024 * 1024;
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/**
 * Downloads one inbound media file from Meta into R2 (two Graph calls: resolve the media id to a short-lived URL,
 * then fetch it with `token`: the business token of the number the file arrived on). Throws on any failure so the scheduler retries with backoff.
 */
export async function downloadToR2(env: { META_GRAPH_VERSION: string; MEDIA: R2Bucket }, token: string, mediaId: string, key: string, fallbackMime: string): Promise<{ mime: string; size: number }> {
  const auth = { authorization: `Bearer ${token}` };
  const metaRes = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const meta = (await metaRes.json().catch(() => null)) as { url?: string; mime_type?: string; file_size?: number } | null;
  if (!metaRes.ok || !meta?.url) throw new Error(`media lookup failed: http ${metaRes.status}`);
  const file = await fetch(meta.url, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  if (!file.ok || !file.body) throw new Error(`media download failed: http ${file.status}`);
  const mime = meta.mime_type ?? fallbackMime;
  const expected = meta.file_size ?? 0;
  if (expected > MAX_DOWNLOAD) throw new Error('media too large');
  let body: ArrayBuffer | ReadableStream;
  if (expected > BUFFER_LIMIT) {
    const fixed = new FixedLengthStream(expected);
    void file.body.pipeTo(fixed.writable);
    body = fixed.readable;
  } else {
    body = await file.arrayBuffer();
  }
  const obj = await env.MEDIA.put(key, body, { httpMetadata: { contentType: mime } });
  return { mime, size: obj.size };
}
