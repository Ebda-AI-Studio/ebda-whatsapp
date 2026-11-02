/**
 * Ebda AI Studio brand identity shared by every Ebda product: company and product names (en/ar), the product list, domains, brand colours and the
 * two guard regexes that keep a bare "Ebda" out of user-facing copy. Pure data: no imports, safe in Workers, browsers and Node.
 *
 * Product-specific helpers (store hosts, "powered by", nav, packages, contact lines) stay in the product that owns them.
 */
export const EBDA = {
  /** The company (master brand). Products are always "Ebda <Product>", never a bare "Ebda" (BRAND-NAME-1). */
  name: 'Ebda AI Studio',
  nameAr: 'ابدأ استوديو للذكاء الاصطناعي',
  /** The company behind Ebda (single source for every operator mention; ruling OPERATOR-1). */
  company: {
    legalNameAr: 'ابدأ استوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
    legalNameEn: 'Ebda AI Studio for Artificial Intelligence, Software and Digital Marketing',
    shortNameAr: 'ابدأ استوديو للذكاء الاصطناعي',
    shortNameEn: 'Ebda AI Studio',
    url: 'https://ebda.app',
  },
  products: {
    store: { nameEn: 'Ebda Store', nameAr: 'ابدأ ستور' },
    whatsapp: { nameEn: 'Ebda Chat', nameAr: 'ابدأ شات' },
  },
  /** Brand colours. No orange anywhere in Ebda's own surfaces (merchants may choose their own). */
  colors: {
    night: '#0A0B0C',
    gold: '#B08D57',
    lift: '#CBA873',
  },
  domains: {
    marketing: 'ebda.app',
    storeApp: 'store.ebda.app',
    api: 'api.ebda.app',
    orders: 'orders.ebda.app',
    storeSuffix: '.ebda.app',
    docs: 'docs.ebda.app',
    help: 'help.ebda.app',
    status: 'status.ebda.app',
    /** Reserved for the post-launch automated WhatsApp tier. */
    whatsapp: 'whatsapp.ebda.app',
    /** The Ebda Chat app (LAUNCH-SUITE-1; its Worker's custom domain). */
    whatsappApp: 'wa.ebda.app',
    /** The shared Ebda AI Studio sign-in (ID-1). */
    accounts: 'accounts.ebda.app',
  },
} as const;

/** Brand name for a locale (`ar*` → Arabic wordmark, everything else Latin). */
export function brandName(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar') ? EBDA.nameAr : EBDA.name;
}

/** A bare English "Ebda" (not Ebda AI Studio / Store / Chat / CRM / ERP). Header names (X-Ebda-…, Ebda-Webhooks) are not copy. */
export const BARE_EN = /(?<!X-)\bEbda\b(?!-Webhooks)(?! (?:Store|Chat|AI Studio|CRM|ERP)\b)/;
/** The Arabic brand spellings with hamza under alef; the plain ابدأ is the everyday verb "start" and stays allowed in copy. */
export const BARE_AR = /(?:إبدأ|إبدا)(?!\s*(?:ستور|استوديو|شات|Chat|CRM|ERP|Store)(?![ء-يٱ-ۓ]))/;
