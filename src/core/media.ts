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

const MP4_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'mmp4']);

/**
 * M-134: the type a file REALLY is, from its first bytes, as one of the allowed spellings (`normaliseMime`), or null. A declared type is a
 * claim by the uploader; Meta and the merchant's customers see the bytes. Needs the first 64 bytes.
 */
export function sniffMime(head: Uint8Array): string | null {
  const at = (s: string, off = 0) => head.length >= off + s.length && [...s].every((c, i) => head[off + i] === c.charCodeAt(0));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return 'image/png';
  if (at('%PDF-')) return 'application/pdf';
  if (at('ftyp', 4) && MP4_BRANDS.has(String.fromCharCode(...head.slice(8, 12)))) return 'video/mp4'; // the brand decides: a QuickTime .mov, an m4a or a HEIC image is not an mp4 Meta accepts
  if (at('OggS') && [...Array(Math.max(0, head.length - 7)).keys()].some((i) => at('OpusHead', i))) return 'audio/ogg;codecs=opus';
  return null;
}

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
