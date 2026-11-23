/**
 * Shared request protection (F9), framework-free: Fetch API `Request`/`Response` only, so Hono (Chat) and Express adapters (Store)
 * both wrap it. (1) request shape: body-size cap (declared and while read) + content-type allow-list -> 413 / 415, parsed-JSON shape
 * limits; (2) rate limiting: an isolate-local token bucket and a fixed-window limiter over a pluggable store with an explicit
 * fail mode. Both products keep their route classes and limits; this owns the mechanics.
 */

// ---- request shape ----

export interface BodyShapeLimits { maxArrayLength: number; maxDepth: number; maxNodes: number }

/**
 * First limit a parsed JSON value exceeds, or null. Checked BEFORE a schema parses it (Ruling ITEST-11, GHSA-mrhx-c7xc-m3w5: a
 * schema builds one issue per failing array element). Iterative: a hostile depth cannot blow the stack.
 */
export function bodyShapeViolation(body: unknown, limits: BodyShapeLimits): string | null {
  const stack: Array<{ v: unknown; d: number }> = [{ v: body, d: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d > limits.maxDepth) return 'nested too deeply';
    if (++nodes > limits.maxNodes) return 'too many fields';
    if (Array.isArray(v)) {
      if (v.length > limits.maxArrayLength) return 'array too long';
      for (const x of v) stack.push({ v: x, d: d + 1 });
    } else {
      for (const x of Object.values(v as Record<string, unknown>)) stack.push({ v: x, d: d + 1 });
    }
  }
  return null;
}

/** A route class: the byte cap and the content types it takes (`null` = size cap only, e.g. a webhook whose type is undocumented). */
export interface ShapeRule { name: string; maxBytes: number; types: readonly string[] | null }

export const mimeOf = (h: string | null | undefined): string => (h ?? '').split(';')[0]!.trim().toLowerCase();

export type ShapeVerdict = { ok: true } | { ok: false; status: 413 | 415; code: 'payload_too_large' | 'unsupported_media' };

/** Judges a request from its headers alone (before any body byte is read). A body-less request has nothing to judge. */
export function checkRequestShape(h: { contentLength: string | null; contentType: string | null; hasBody: boolean }, rule: ShapeRule): ShapeVerdict {
  if (!h.hasBody) return { ok: true };
  if (h.contentLength !== null && /^\d+$/.test(h.contentLength) && Number(h.contentLength) > rule.maxBytes) return { ok: false, status: 413, code: 'payload_too_large' };
  if (rule.types && h.contentLength !== '0' && !rule.types.includes(mimeOf(h.contentType))) return { ok: false, status: 415, code: 'unsupported_media' };
  return { ok: true };
}

export const refusalResponse = (status: number, error: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', ...extra } });

/** Header check as a `Response` to return, or null to go on. */
export function guardShape(req: Request, rule: ShapeRule): Response | null {
  const v = checkRequestShape({ contentLength: req.headers.get('content-length'), contentType: req.headers.get('content-type'), hasBody: req.body !== null }, rule);
  return v.ok ? null : refusalResponse(v.status, v.code);
}

/** Reads a whole body, refusing past `max` (counts bytes as they arrive: works with no Content-Length). null = over the cap. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
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

// ---- rate limiting ----

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const H16 = /^[0-9a-f]{1,4}$/;

/** Eight 16-bit groups of a valid IPv6 literal (an embedded dotted IPv4 tail counts as two groups), or null when it is not valid. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  const m = V4.exec(s.slice(s.lastIndexOf(':') + 1));
  if (s.includes('.')) {
    if (!m) return null;
    const tail = m.slice(1).map(Number);
    s = s.slice(0, s.lastIndexOf(':') + 1) + ((tail[0]! << 8) | tail[1]!).toString(16) + ':' + ((tail[2]! << 8) | tail[3]!).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const side = (x: string) => (x === '' ? [] : x.split(':'));
  const left = side(parts[0]!);
  const right = parts.length === 2 ? side(parts[1]!) : [];
  if (![...left, ...right].every((g) => H16.test(g))) return null;
  if (parts.length === 1 ? left.length !== 8 : left.length + right.length > 7) return null;
  const fill = parts.length === 2 ? Array<string>(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16));
}

/**
 * A client for rate limiting. IPv4 -> the address (/32). IPv6 -> its /64 (one subscriber's prefix), except IPv4-mapped (::ffff:a.b.c.d) and
 * IPv4-compatible (::a.b.c.d) forms, which key as the embedded IPv4 so they neither share one bucket nor dodge the IPv4 one. A `%zone` suffix is
 * dropped and case folded. Anything that is not a valid address keys as its own raw string (`raw:`), never a shared bucket; no IP = `unknown`.
 */
export function clientKey(ip: string | null): string {
  if (!ip) return 'unknown';
  const raw = ip;
  if (ip.length > 64) return `raw:${raw.slice(0, 128)}`; // no real address (with a zone) is this long; never parse hostile length
  const z = ip.indexOf('%');
  const s = (z === -1 ? ip : ip.slice(0, z)).trim().toLowerCase();
  if (V4.test(s)) return s;
  const g = s.includes(':') ? ipv6Groups(s) : null;
  if (!g) return `raw:${raw.slice(0, 128)}`;
  const v4 = (): string => `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4();
  if (g.slice(0, 6).every((x) => x === 0) && (g[6]! > 0 || g[7]! > 1)) return v4(); // :: and ::1 stay IPv6
  return g.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64';
}

/**
 * Token buckets per key, in this isolate's memory. STALENESS CLASS: BOUNDED-stale (per isolate: resets on eviction, several isolates
 * each hold their own bucket, so the effective limit is up to isolates x rate). Only for limits that shed abusive volume; never for
 * money or permissions (use `FixedWindowLimiter` over a shared store, fail closed). The map is bounded (oldest keys dropped).
 */
export class Buckets {
  private readonly map = new Map<string, { tokens: number; at: number }>();
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly maxKeys: number;
  constructor(ratePerSec: number, burst: number, maxKeys = 5_000) {
    this.ratePerSec = ratePerSec;
    this.burst = burst;
    this.maxKeys = maxKeys;
  }
  /** 0 = allowed (one token taken); otherwise the seconds to wait. */
  take(key: string, now = Date.now()): number {
    const b = this.map.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.ratePerSec);
    b.at = now;
    this.map.delete(key);
    this.map.set(key, b);
    if (this.map.size > this.maxKeys) this.map.delete(this.map.keys().next().value as string);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.max(1, Math.ceil((1 - b.tokens) / this.ratePerSec));
  }
}

/** A shared counter (Durable Object, KV, Redis). `hit` adds one to the key's window and returns the count so far and when the window ends (epoch ms). */
export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<{ count: number; resetAtMs: number }>;
}

export type FailMode = 'open' | 'closed';
export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSec: number; reason: 'limited' | 'store_error' };

/**
 * Fixed-window limiter over a shared store. `failMode` is explicit, no default: `open` (a store outage lets traffic through: public
 * reads, auth limiters that must not lock everyone out) or `closed` (an outage refuses: money routes and anything abuse-sensitive).
 */
export class FixedWindowLimiter {
  private readonly store: RateLimitStore;
  private readonly opts: { limit: number; windowMs: number; failMode: FailMode };
  constructor(store: RateLimitStore, opts: { limit: number; windowMs: number; failMode: FailMode }) {
    this.store = store;
    this.opts = opts;
  }
  async check(key: string, now = Date.now()): Promise<RateVerdict> {
    let r: { count: number; resetAtMs: number };
    try { r = await this.store.hit(key, this.opts.windowMs); } catch {
      return this.opts.failMode === 'open' ? { allowed: true } : { allowed: false, retryAfterSec: Math.max(1, Math.ceil(this.opts.windowMs / 1000)), reason: 'store_error' };
    }
    if (r.count <= this.opts.limit) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((r.resetAtMs - now) / 1000)), reason: 'limited' };
  }
}

/** 429 with Retry-After for a refused verdict (null when allowed). */
export function rateLimitedResponse(v: RateVerdict): Response | null {
  if (v.allowed) return null;
  return refusalResponse(429, 'rate_limited', { 'retry-after': String(v.retryAfterSec), 'cache-control': 'no-store' });
}
