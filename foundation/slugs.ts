/**
 * Reserved store slugs — the SINGLE source of truth for every Ebda product.
 *
 * A store lives at `<slug>.ebda.app`, so a slug that equals one of our own service labels (`app`, `api`, `orders`, …) would collide with a real
 * host or let a merchant impersonate the platform. Adding a label here is a one-line change that takes effect everywhere. The brand-impersonation
 * list (`protected-slugs`) stays in the Store.
 */
export const RESERVED_SLUGS = [
  'app',
  'api',
  'docs',
  'help',
  'status',
  'whatsapp',
  'www',
  'admin',
  'orders',
  'mail',
  'cdn',
  'assets',
  'static',
  'store',
  'dashboard',
  'billing',
  'support',
  'blog',
  // Ebda product family (PRODUCT-NAME-1): `store` also hosts cache revalidation.
  'crm',
  'erp',
  'hub',
  'id',
  'accounts',
  // The R2 public bucket's custom domain (media.ebda.app): a platform host, never a store.
  'media',
  // Ebda WhatsApp (https://wa.ebda.app), a product host and an allow-listed identity origin.
  'wa',
] as const;

export type ReservedSlug = (typeof RESERVED_SLUGS)[number];

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_SLUGS);

/** True when `slug` (case-insensitive, trimmed) is reserved and can never be a store. */
export function isReservedSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  return RESERVED_SET.has(slug.trim().toLowerCase());
}

/**
 * The demo showroom family (Ruling B2-17): `storedemo` and `storedemo-*`. Refused on signup / create / slug change but deliberately NOT in
 * RESERVED_SLUGS: a reserved label is a PLATFORM host, and `storedemo.ebda.app` must keep resolving as a store. `storedemonstration` is an ordinary slug.
 */
export function isDemoShowroomSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  const s = slug.trim().toLowerCase();
  return s === 'storedemo' || s.startsWith('storedemo-');
}

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 40;

export type SlugFormatError = 'SLUG_TOO_SHORT' | 'SLUG_TOO_LONG' | 'SLUG_INVALID_CHARS' | 'SLUG_INVALID_HYPHEN';

const SLUG_CHARS = /^[a-z0-9-]+$/;

/**
 * Format-only check (no reserved-list lookup): lowercase a-z0-9 and hyphen, 3-40 chars, no leading/trailing/double hyphen. Input is NOT
 * normalised: `Amelia` is invalid, not silently lowercased, so what is validated is exactly what gets stored and routed. Returns the first failing
 * code in a fixed order (chars, short, long, hyphen), or null when the slug is well-formed.
 */
export function slugFormatError(slug: string): SlugFormatError | null {
  if (!SLUG_CHARS.test(slug)) return 'SLUG_INVALID_CHARS';
  if (slug.length < SLUG_MIN_LENGTH) return 'SLUG_TOO_SHORT';
  if (slug.length > SLUG_MAX_LENGTH) return 'SLUG_TOO_LONG';
  if (slug.startsWith('-') || slug.endsWith('-') || slug.includes('--')) return 'SLUG_INVALID_HYPHEN';
  return null;
}
