import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { MAX_PROOF_BYTES } from './billing/instapay';
import { parseCode } from './campaigns/links';
import { MAX_IMPORT_BYTES } from './campaigns/contacts';
import { MAX_DOCUMENT_BYTES } from './media';
import { verifyMetaSignature } from './meta/signature';

/**
 * One module, in front of every route: (1) a body-size cap applied before the body is read (Content-Length) and while it is read
 * (chunked bodies, no Content-Length), (2) a content-type allow-list per route class, (3) per-key token buckets on the two public
 * routes (tracked links per workspace, the Meta webhook per phone_number_id). Over a size: 413 payload_too_large. A type that is not allowed:
 * 415 unsupported_media. Over a rate: 429 rate_limited with Retry-After.
 */

const KB = 1024;
const MB = 1024 * KB;
/** Webhook bodies (Meta, Kashier): a real payload is a few KB; 256 KB is generous. */
export const WEBHOOK_MAX_BYTES = 256 * KB;
/** Every JSON API write. */
export const JSON_MAX_BYTES = 1 * MB;
/** Uploads keep their own, larger limits (the route still applies its exact rule); the guard allows the multipart envelope on top. */
const MULTIPART_OVERHEAD = 1 * MB;
export const MEDIA_UPLOAD_MAX_BYTES = MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD;
export const IMPORT_UPLOAD_MAX_BYTES = MAX_IMPORT_BYTES + MULTIPART_OVERHEAD;
export const PROOF_UPLOAD_MAX_BYTES = MAX_PROOF_BYTES + 64 * KB;

const JSON_TYPES = ['application/json'];
const MULTIPART = ['multipart/form-data'];
const PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

type RouteClass = { name: string; maxBytes: number; types: string[] | null };

const STORE = /^\/api\/v1\/stores\/[^/]+/;
/** Which class a request belongs to. null = nothing to guard (no body expected, or not one of ours). */
export function classify(method: string, path: string): RouteClass | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (path === '/meta/webhook') return { name: 'webhook', maxBytes: WEBHOOK_MAX_BYTES, types: JSON_TYPES };
  // Kashier's Content-Type is not documented anywhere we can check, and its HMAC over the raw body is the authentication: a wrong guess here
  // would silently drop paid top-ups, so this webhook gets the size cap only.
  if (path === '/kashier/webhook') return { name: 'webhook-kashier', maxBytes: WEBHOOK_MAX_BYTES, types: null };
  if (method === 'POST' && new RegExp(`${STORE.source}/media$`).test(path)) return { name: 'upload-media', maxBytes: MEDIA_UPLOAD_MAX_BYTES, types: MULTIPART };
  if (method === 'POST' && new RegExp(`${STORE.source}/imports$`).test(path)) return { name: 'upload-import', maxBytes: IMPORT_UPLOAD_MAX_BYTES, types: MULTIPART };
  if (method === 'PUT' && new RegExp(`${STORE.source}/wallet/instapay/[^/]+/proof$`).test(path)) return { name: 'upload-proof', maxBytes: PROOF_UPLOAD_MAX_BYTES, types: PROOF_TYPES };
  if (path.startsWith('/api/v1/')) return { name: 'api', maxBytes: JSON_MAX_BYTES, types: JSON_TYPES };
  return { name: 'other', maxBytes: JSON_MAX_BYTES, types: null };
}

/**
 * Token buckets, per key, in this isolate's memory. STALENESS CLASS: BOUNDED-stale by design. The state is per isolate: it resets when the
 * isolate is evicted and several isolates each hold their own bucket, so the effective limit is up to (isolates x rate). That is
 * acceptable because the limits only shed clearly abusive volume (they sit far above any real campaign or webhook burst), they never
 * guard money or permissions. The Workers Rate Limiting binding is not configured for this Worker; if it is later, swap `take`.
 * The map is bounded (oldest keys dropped) so a stream of made-up keys cannot grow memory.
 */
export class Buckets {
  private readonly map = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly ratePerSec: number, private readonly burst: number, private readonly maxKeys = 5_000) {}
  /** 0 = allowed (one token taken); otherwise the seconds to wait. */
  take(key: string, now = Date.now()): number {
    const b = this.map.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.ratePerSec);
    b.at = now;
    this.map.delete(key);
    this.map.set(key, b); // most recent last
    if (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value as string);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.ratePerSec));
  }
}

export type GuardLimits = { webhook: { ratePerSec: number; burst: number }; link: { ratePerSec: number; burst: number } };
/**
 * Defaults sit far above real traffic. Meta webhooks: one request per message batch; 50/s sustained and a burst of 200 per phone number is
 * several times what one busy number sends. Tracked links: per client per workspace, 20/s and a burst of 60 (a person taps a link a few times, a campaign wave comes from many clients).
 * RESIDUAL (webhooks): a signed request over the limit gets 429, which Meta (and Kashier) redeliver with backoff for days, so a legitimate
 * event is delayed, not lost; only a number that keeps exceeding the limit keeps being delayed. Unsigned requests are never counted, so
 * nobody can spend another number's allowance by naming it.
 */
export const DEFAULT_LIMITS: GuardLimits = { webhook: { ratePerSec: 50, burst: 200 }, link: { ratePerSec: 20, burst: 60 } };

const json = (status: number, error: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...extra } });
const tooLarge = () => json(413, 'payload_too_large');
const mimeOf = (h: string | null) => (h ?? '').split(';')[0]!.trim().toLowerCase();

/** Reads a whole body, refusing past `max` (counts bytes as they arrive: works with no Content-Length). null = over the cap. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength; }
  return out;
}

/** Phone number ids a Meta webhook body speaks for (falls back to the WABA id for events that carry no metadata). */
function webhookKeys(bytes: Uint8Array): string[] {
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return []; }
  const keys = new Set<string>();
  const entries = (body as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return [];
  for (const e of entries.slice(0, 100) as { id?: unknown; changes?: { value?: { metadata?: { phone_number_id?: unknown } } }[] }[]) {
    let found = false;
    for (const ch of Array.isArray(e?.changes) ? e.changes.slice(0, 100) : []) {
      const pn = ch?.value?.metadata?.phone_number_id;
      if (typeof pn === 'string' && pn.length <= 40) { keys.add(`pn:${pn}`); found = true; }
    }
    if (!found && typeof e?.id === 'string' && e.id.length <= 40) keys.add(`waba:${e.id}`);
  }
  return [...keys];
}

/**
 * Content-type allow-list for the API, mounted AFTER the auth middleware so an unauthenticated or unauthorised caller still gets 401/403
 * (not a hint about what the route accepts). A body with a type outside the route class: 415 unsupported_media. No body: nothing to judge.
 */
export function apiContentTypes(): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    const cls = classify(req.method, new URL(req.url).pathname);
    if (cls?.types && req.body !== null && req.headers.get('content-length') !== '0' && !cls.types.includes(mimeOf(req.headers.get('content-type')))) return json(415, 'unsupported_media');
    return next();
  };
}

export function requestGuards(limits: GuardLimits = DEFAULT_LIMITS): MiddlewareHandler<{ Bindings: Env }> {
  const webhookBuckets = new Buckets(limits.webhook.ratePerSec, limits.webhook.burst);
  const linkBuckets = new Buckets(limits.link.ratePerSec, limits.link.burst);

  return async (c: Context<{ Bindings: Env }>, next) => {
    const req = c.req.raw;
    const path = new URL(req.url).pathname;

    // Public tracked link: limited per client per workspace. A malformed code is left to the route (404 before any Durable Object).
    if (req.method === 'GET' && path.startsWith('/t/')) {
      let raw = path.slice(3);
      try { raw = decodeURIComponent(raw); } catch { return next(); }
      const parsed = parseCode(raw);
      if (parsed) {
        // Keyed per client AND workspace: a forged but well-formed code naming a store only spends the sender's own share, never the
        // store's allowance for its real customers. (A client without cf-connecting-ip, local or tests, shares one key per workspace.)
        const client = req.headers.get('cf-connecting-ip') ?? 'unknown';
        const wait = linkBuckets.take(`${client}|${parsed.workspaceId}`);
        if (wait) return json(429, 'rate_limited', { 'retry-after': String(wait), 'cache-control': 'no-store' });
      }
      return next();
    }

    const cls = classify(req.method, path);
    if (!cls || req.body === null) return next(); // nothing to read: no size or type to judge

    const declared = req.headers.get('content-length');
    if (declared !== null && /^\d+$/.test(declared)) {
      if (Number(declared) > cls.maxBytes) return tooLarge(); // refused before a body byte is read
    }
    // The type allow-list of the API classes runs after authentication (apiContentTypes); webhooks have no login, so theirs runs here.
    if (cls.name === 'webhook' && declared !== '0' && !cls.types!.includes(mimeOf(req.headers.get('content-type')))) return json(415, 'unsupported_media');

    if (path === '/meta/webhook') {
      // Small and signed: read it all (counting bytes), check the signature, then count it against its phone numbers.
      const bytes = await readCapped(req, cls.maxBytes);
      if (!bytes) return tooLarge();
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (await verifyMetaSignature(buf, req.headers.get('x-hub-signature-256'), c.env.META_APP_SECRET)) {
        let wait = 0;
        for (const key of webhookKeys(bytes)) wait = Math.max(wait, webhookBuckets.take(key));
        if (wait) return json(429, 'rate_limited', { 'retry-after': String(wait) });
      }
      c.req.raw = new Request(req, { body: buf }); // the route reads (and verifies) the same bytes
      return next();
    }

    if (declared !== null) return next(); // the runtime stops reading at the declared length, which is within the cap
    // Chunked: count while the route reads; past the cap the stream errors and the answer becomes 413.
    let tripped = false;
    let seen = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        seen += chunk.byteLength;
        if (seen > cls.maxBytes) { tripped = true; ctl.error(new Error('payload_too_large')); return; }
        ctl.enqueue(chunk);
      },
    });
    c.req.raw = new Request(req, { body: req.body.pipeThrough(counter), duplex: 'half' } as RequestInit);
    await next();
    if (tripped) c.res = tooLarge();
  };
}
