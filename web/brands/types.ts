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
  /** Help guides base URL (`<base>/<guide-slug>`); null hides the "How?" links. */
  helpBase: string | null;
  /** The linked store product, when the brand has one; null hides the store step everywhere. */
  storeName: string | null;
};
