/**
 * A tenant on its own OpenID Connect provider signs in from the browser with Authorization Code + PKCE. The issuer is data here so the same
 * origin is written into this brand's `_headers` (connect-src and form-action), exactly. `refresh` lets the page use a refresh token if the
 * provider issues one; otherwise it signs in again.
 */
export type OidcWebConfig = { issuer: string; clientId: string; audience?: string; refresh?: boolean };

/** What the inbox page needs from a brand. Selected at build time: `BRAND=<id> npm run build:web` (default: ebda). */
export type WebBrand = {
  id: string;
  /** Shown in the tab title. */
  productName: string;
  /** The rail mark (served from web/brands/<brand>/public) and its accessible name (the company). */
  mark: { src: string; alt: string; width: number; height: number };
  /** Apple touch icon path in this brand's public folder, or null for none. */
  appleTouchIcon: string | null;
  /** Where the access token comes from (identity contract v1); null for a tenant on its own identity provider (sign-in handled by its portal). */
  accountsUrl: string | null;
  /** The sign-in entry's lockup: the company line, then the product, in both languages. */
  gate?: { studio: { ar: string; en: string }; product: { ar: string; en: string } };
  /** Sent as `product=` to the accounts sign-in so its page names this product; null for none. */
  signInProduct?: string | null;
  /** The Arabic product name for the tab title ("ar | en"); omitted = the English name alone. */
  productNameAr?: string;
  /** The tenant's own OpenID Connect provider for browser sign-in; null when sign-in is `accountsUrl` or handled by the tenant's portal. */
  oidc?: OidcWebConfig | null;
  /** Where a help guide lives for the interface language (the slug is the docs/help file name without its NN- prefix). Null hides the "How?" links. */
  helpUrl: ((lang: 'ar' | 'en', slug: string) => string) | null;
  /** The linked store product, when the brand has one; null hides the store step everywhere. */
  storeName: string | null;
  /** The linked store's admin origin; the upgrade card links to `<origin>/stores/<id>/billing`. Null hides the link (the card still explains). */
  storeAdminUrl?: string | null;
  /** Where a person writes to support (shown in error copy that says to contact us); null falls back to the plain word "support". */
  supportEmail: string | null;
  /**
   * What a shared link to this page shows (chat preview, search result): written into the page head at build time by `shareHead`.
   * Omitted = no description, canonical or preview tags at all; a brand never inherits another brand's.
   */
  share?: ShareConfig;
};

export type ShareConfig = {
  /** The page's one public address: the canonical link and og:url. */
  url: string;
  /** The product's name as a search engine should file it, and its name in the page's other language. */
  name: string;
  alternateName?: string;
  /** The preview's headline and its sentence (the page's first language). */
  title: string;
  description: string;
  /** Open Graph locale of the copy above (ar_EG), and the other locale the page speaks. */
  locale: string;
  alternateLocale?: string;
  /** BCP 47 codes for the structured data. */
  languages: string[];
  /** The preview image in this brand's public folder: a 1200 x 630 PNG, with the sentence a screen reader gets for it. */
  image: { path: string; width: number; height: number; alt: string };
  /** The company behind the product, by its public name (never the registered legal name). */
  publisher: { name: string; url: string };
};
