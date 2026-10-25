import type { Env } from '../../env';
import { storeLink } from '../store-link';

/**
 * Tracked links. Every recipient gets their own short link `/t/<workspaceId>.<secret>`: the secret is 16 random bytes (128 bits,
 * base64url), so a code cannot be guessed, and it names the one recipient of one campaign, which is how a click is attributed
 * without the phone number ever being in a URL or a log. The destination is the merchant's own https link, fixed per campaign.
 */
export const CODE_SECRET_CHARS = 22; // 16 bytes in base64url, no padding
export const CODE_RE = /^([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{22})$/;

export function newCode(workspaceId: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${workspaceId}.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Splits a code from a URL into its workspace and the whole code; null when it is not even shaped like one. */
export function parseCode(raw: string): { workspaceId: string; code: string } | null {
  const m = CODE_RE.exec(raw);
  return m ? { workspaceId: m[1]!, code: raw } : null;
}

export type LinkConfig = {
  /** This Worker's public origin, no trailing slash; null = tracked links are unavailable. */
  baseUrl: (env: Env) => string | null;
  /** The suite-wide secret that hashes a phone into a buyerKey; undefined = clicks are recorded without one. */
  buyerSecret: (env: Env) => string | undefined;
};
const DEFAULT_CONFIG: LinkConfig = {
  baseUrl: (env) => env.PUBLIC_BASE_URL?.replace(/\/+$/, '') || null,
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
