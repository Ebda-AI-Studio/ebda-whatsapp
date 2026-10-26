import type { Env } from '../../env';
import { storeLink } from '../store-link';

/**
 * Tracked links. Every recipient gets their own short link `/t/<workspaceId>.<random>.<mac>`: 16 random bytes (128 bits) and a 16-byte
 * HMAC over `<workspaceId>.<random>` (Ruling WA-LINK-2), both base64url. The random part makes a code unguessable; the MAC lets the edge
 * reject a made-up code (and a code moved to another store: the workspace is inside the MAC) before any rate bucket or Durable Object is
 * touched. The key is derived with HKDF under its own versioned label, so it is never the key of any other signed URL. The code names the
 * one recipient of one campaign, which is how a click is attributed without the phone number ever being in a URL or a log.
 */
export const CODE_SECRET_CHARS = 22; // 16 bytes in base64url, no padding
export const CODE_RE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;
const KEY_INFO = 'tracked-link-code/v1';

const b64url = (bytes: Uint8Array) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const keys = new Map<string, Promise<CryptoKey>>();
function codeKey(secret: string): Promise<CryptoKey> {
  let k = keys.get(secret);
  if (!k) {
    k = (async () => {
      const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(KEY_INFO) }, base, 256);
      return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    })();
    keys.set(secret, k);
  }
  return k;
}
async function macFor(secret: string, body: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await codeKey(secret), new TextEncoder().encode(body)));
  return b64url(sig.slice(0, 16));
}

/** A new signed code for one recipient (async: Web Crypto). Mint before a synchronous storage transaction, then use it inside. */
export async function newSignedCode(workspaceId: string, secret: string): Promise<string> {
  const body = `${workspaceId}.${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  return `${body}.${await macFor(secret, body)}`;
}

/** True only for a well-formed code whose MAC matches. Shape is checked first; the MAC is compared in constant time. */
export async function verifyCode(raw: string, secret: string): Promise<boolean> {
  const m = CODE_RE.exec(raw);
  if (!m) return false;
  const expected = await macFor(secret, `${m[1]}.${m[2]}`);
  const got = m[3]!;
  let diff = expected.length ^ got.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  return diff === 0;
}

/** The link-code key's HMAC of `probe` (tests only: proves the derived key differs from the raw secret). */
export async function linkCodeKeyFingerprint(secret: string, probe: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await codeKey(secret), new TextEncoder().encode(probe)));
}

/** Splits a code from a URL into its workspace and the whole code; null when it is not even shaped like one. */
export function parseCode(raw: string): { workspaceId: string; code: string } | null {
  const m = CODE_RE.exec(raw);
  return m ? { workspaceId: m[1]!, code: raw } : null;
}

export type LinkConfig = {
  /** This Worker's public origin, no trailing slash; null = tracked links are unavailable. */
  baseUrl: (env: Env) => string | null;
  /** The secret the link codes are signed with (HKDF-derived key); undefined = tracked links are unavailable (fail closed). */
  signingSecret: (env: Env) => string | undefined;
  /** The suite-wide secret that hashes a phone into a buyerKey; undefined = clicks are recorded without one. */
  buyerSecret: (env: Env) => string | undefined;
};
const DEFAULT_CONFIG: LinkConfig = {
  baseUrl: (env) => env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null,
  signingSecret: (env) => env.PROOF_URL_SECRET || undefined,
  buyerSecret: (env) => storeLink().buyerSecret(env),
};
let current: LinkConfig = DEFAULT_CONFIG;
/** Replaces the wiring (tests); returns the previous one so it can be restored. */
export function configureCampaignLinks(c: Partial<LinkConfig>): LinkConfig {
  const previous = current;
  current = { ...DEFAULT_CONFIG, ...c };
  return previous;
}
export const campaignLinks = (): LinkConfig => current;

const BLOCKED_HOST = /(^|\.)(localhost|local|internal|localdomain|home|lan|corp)$/i;

/**
 * A destination the merchant may link to: https only, no credentials in it, a real DNS name (no IP address, no single-label or internal
 * host), at most 2000 characters, and not this service's own origin (a loop). Returns the normalised URL or null.
 */
export function validateTrackedUrl(raw: string, ownOrigin?: string | null): string | null {
  if (raw.length > 2000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || BLOCKED_HOST.test(host) || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
  if (ownOrigin) {
    try {
      if (new URL(ownOrigin).hostname.toLowerCase() === host) return null;
    } catch {
      // an unparsable own origin cannot match anything
    }
  }
  return u.toString();
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 50);

/** The destination with utm_source / utm_medium / utm_campaign added where the merchant did not set them already. */
export function withUtm(destination: string, campaignName: string, campaignId: string): string {
  const u = new URL(destination);
  if (!u.searchParams.has('utm_source')) u.searchParams.set('utm_source', 'whatsapp');
  if (!u.searchParams.has('utm_medium')) u.searchParams.set('utm_medium', 'campaign');
  if (!u.searchParams.has('utm_campaign')) u.searchParams.set('utm_campaign', slug(campaignName) || campaignId.slice(0, 8));
  return u.toString();
}

/** Link-preview and crawler fetches follow the link too; they are not people and must not count as clicks. */
export const isAutomatedFetch = (userAgent: string | undefined, method: string): boolean =>
  method === 'HEAD' || /whatsapp|facebookexternalhit|facebot|meta-externalagent|twitterbot|telegrambot|slackbot|linkedinbot|bot\b|crawler|spider|preview/i.test(userAgent ?? '');
