/**
 * Ebda brand identity — the single source of truth for every user-visible
 * brand string, colour, font, domain and sender address across apps/* and
 * packages/*. Import from `@ebda/shared` (the package scope is an internal
 * identifier and is intentionally unchanged).
 *
 * Pure data + pure helpers: no runtime imports, safe in Workers, middleware,
 * Next.js client bundles and Node alike. Do not re-hardcode these values
 * elsewhere; `tests/unit/no-force-branding.test.ts` guards against inherited third-party brand strings.
 */

export const BRAND = {
  name: 'Ebda AI Studio',
  nameAr: 'ابدأ ستوديو للذكاء الاصطناعي',
  /**
   * The PRODUCT (the store builder). `name`/`nameAr` above name the company; anything naming the product or the Service
   * reads this (ruling PRODUCT-NAME-1). Future products: Ebda Chat / CRM / ERP.
   */
  product: {
    nameEn: 'Ebda Store',
    nameAr: 'ابدأ ستور',
  },
  /**
   * The WhatsApp PRODUCT (Ebda Chat, by Ebda AI Studio): always the full name, never a bare "Ebda" (BRAND-NAME-1).
   * Lives at `domains.whatsappApp`; its marketing page is /whatsapp on the marketing site.
   */
  productWhatsapp: {
    nameEn: 'Ebda Chat',
    nameAr: 'ابدأ شات',
  },
  /** The company behind Ebda (single source for every operator mention; ruling OPERATOR-1). */
  company: {
    legalNameAr: 'ابدأ ستوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
    legalNameEn:
      'Ebda Studio for Artificial Intelligence, Software Development, and Digital Marketing',
    shortNameAr: 'ابدأ ستوديو للذكاء الاصطناعي',
    shortNameEn: 'Ebda AI Studio',
    /** Founding date (Ahmad, 2026-11-03): ISO, rendered with formatLegalDate, and `foundingDate` in the Organization JSON-LD. */
    foundedOn: '2026-09-11',
    url: 'https://ebda.app',
  },
  /**
   * The studio's office (Ahmad, 2026-11-03): a VIRTUAL office in Cairo. Meetings are online; in-person meetings only by
   * appointment, so no page may imply walk-in hours. Shown on /about, /contact and the legal notice and in the Organization
   * JSON-LD as a PostalAddress (`officePostalAddress`); never in the footer. One source: read these, never hardcode.
   */
  office: {
    addressAr:
      'مصر الجديدة، فرع الماظة — شارع الماظة الرئيسي عند تقاطعه مع شارع الثورة، عمارة بنك الإسكندرية، الدور الثامن، القاهرة',
    addressEn:
      'Almaza branch, Heliopolis (Masr El Gedida): Almaza Main St. at El Thawra St., Bank of Alexandria building, 8th floor, Cairo, Egypt',
    mapUrl: 'https://maps.app.goo.gl/42gtfccR2egFvYHE7',
    meetingAr: 'الاجتماعات أونلاين على Google Meet، ولقاءات المكتب في القاهرة بميعاد سابق بس.',
    meetingEn: 'We meet online on Google Meet; in-person meetings in Cairo by appointment only.',
    locality: 'Cairo',
    region: 'Cairo',
    country: 'EG',
  },
  tagline: 'Your store, live today.',
  taglineAr: 'متجرك أونلاين النهاردة.',
  colors: {
    night: '#0A0B0C',
    gold: '#B08D57',
    lift: '#CBA873',
  },
  fonts: {
    sans: 'Geist',
    mono: 'Geist Mono',
    arabic: 'IBM Plex Sans Arabic',
    stacks: {
      sans: '"Geist", ui-sans-serif, system-ui, sans-serif',
      mono: '"Geist Mono", ui-monospace, "SFMono-Regular", monospace',
      arabic: '"IBM Plex Sans Arabic", ui-sans-serif, system-ui, sans-serif',
    },
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500&display=swap',
  },
  domains: {
    marketing: 'ebda.app',
    /**
     * The Ebda Store merchant app (sign-up, plan, payment, onboarding, dashboard).
     * `admin.ebda.app` is RETIRED (Ruling HOST-STORE-1): no surface, reserved slug, 404.
     * Future products follow the same pattern (`wa.`, `crm.`, one login at `accounts.`).
     */
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
  /**
   * The ONE public contact address. Only hello@ and security@ receive mail
   * (Cloudflare Email Routing), so this must stay hello@ (Ruling EBDA-BILLFU-5).
   */
  supportEmail: 'ahlan@ebda.app',
  noReplyEmail: 'no-reply@ebda.app',
  /**
   * Public WhatsApp line for pre-sales questions (the marketing site header, FAQ and close).
   * E.164 with the leading +; use `whatsappUrl()` / `whatsappDisplay()` to render it.
   */
  contact: {
    whatsapp: '+201514191411',
  },
  legalUrls: {
    terms: 'https://ebda.app/terms',
    privacy: 'https://ebda.app/privacy',
    refunds: 'https://ebda.app/refund/',
  },
} as const;

export type Brand = typeof BRAND;

/** Brand name for a locale (`ar*` → Arabic wordmark, everything else Latin). */
export function brandName(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar') ? BRAND.nameAr : BRAND.name;
}

/** Product name for merchant/store surfaces, separate from the company identity. */
export function productName(locale?: string | null): string {
  return locale?.toLowerCase().startsWith('ar') ? BRAND.product.nameAr : BRAND.product.nameEn;
}

/** The office for a locale: address, map link and how we meet (BRAND.office). */
export function officeInfo(locale?: string | null) {
  const ar = !!locale && locale.toLowerCase().startsWith('ar');
  const o = BRAND.office;
  return {
    address: ar ? o.addressAr : o.addressEn,
    mapUrl: o.mapUrl,
    meeting: ar ? o.meetingAr : o.meetingEn,
  };
}

/** The Organization's schema.org PostalAddress (street line in English; locality, region and country are fixed codes). */
export function officePostalAddress() {
  const o = BRAND.office;
  return {
    '@type': 'PostalAddress',
    streetAddress: o.addressEn,
    addressLocality: o.locality,
    addressRegion: o.region,
    addressCountry: o.country,
  };
}

/** `https://<host>` for a bare hostname. */
export function brandUrl(host: string): string {
  return `https://${host}`;
}

/** Marketing site origin, e.g. `https://ebda.app`. */
export const BRAND_MARKETING_URL = brandUrl(BRAND.domains.marketing);
/** Ebda Store merchant app origin, e.g. `https://store.ebda.app`. */
export const BRAND_STORE_APP_URL = brandUrl(BRAND.domains.storeApp);
/** API origin, e.g. `https://api.ebda.app`. */
export const BRAND_API_URL = brandUrl(BRAND.domains.api);

/** `https://wa.me/<digits>` for the public WhatsApp line (digits only, no +), optional prefilled text. */
export function whatsappUrl(text?: string): string {
  const url = `https://wa.me/${BRAND.contact.whatsapp.replace(/\D/g, '')}`;
  return text ? `${url}?text=${encodeURIComponent(text)}` : url;
}

/** The WhatsApp number for display, e.g. `+20 151 419 1411` (render left-to-right, selectable). */
export function whatsappDisplay(): string {
  return BRAND.contact.whatsapp.replace(/^\+20(\d{3})(\d{3})(\d{4})$/, '+20 $1 $2 $3');
}

/** Hosted PNG of the mark for transactional email (mail clients drop SVG). */
export const BRAND_EMAIL_LOGO_URL = `${BRAND_MARKETING_URL}/email-logo.png`;

/**
 * The approved Ebda mark (2026-10-22 logo pack: three gold faces forming a doorway) as an inline SVG
 * string, 78.3x149 viewBox (width = size x 0.526). Same geometry + gradients as brand/logo/svg/03d-symbol-gold.svg.
 * Gradient ids are fixed (`ebda-mark-*`): repeats of the mark on one page carry identical defs, which is valid.
 * Decorative by default; `size` is the rendered HEIGHT in px.
 */
const MARK_DEFS = `<defs><linearGradient id="ebda-mark-lint" gradientUnits="userSpaceOnUse" x1="47.04" y1="5.06" x2="58.87" y2="78.05"><stop offset="0.0" stop-color="#DAB27A"/><stop offset="0.056" stop-color="#DAB27A"/><stop offset="0.167" stop-color="#D2AA73"/><stop offset="0.278" stop-color="#CCA46E"/><stop offset="0.389" stop-color="#C8A06A"/><stop offset="0.5" stop-color="#C49C67"/><stop offset="0.611" stop-color="#BE9662"/><stop offset="0.722" stop-color="#B78E5C"/><stop offset="0.833" stop-color="#AE8656"/><stop offset="0.944" stop-color="#A57E52"/><stop offset="1.0" stop-color="#A57E52"/></linearGradient><linearGradient id="ebda-mark-col" gradientUnits="userSpaceOnUse" x1="54.53" y1="77.53" x2="89.44" y2="116.79"><stop offset="0.0" stop-color="#A27B4E"/><stop offset="0.056" stop-color="#A27B4E"/><stop offset="0.167" stop-color="#A17A4D"/><stop offset="0.278" stop-color="#9D774B"/><stop offset="0.389" stop-color="#987448"/><stop offset="0.5" stop-color="#946F44"/><stop offset="0.611" stop-color="#906C42"/><stop offset="0.722" stop-color="#8E6A40"/><stop offset="0.833" stop-color="#8B673F"/><stop offset="0.944" stop-color="#8A663E"/><stop offset="1.0" stop-color="#8A663E"/></linearGradient><linearGradient id="ebda-mark-left" gradientUnits="userSpaceOnUse" x1="-10.44" y1="99.88" x2="48.82" y2="87.05"><stop offset="0.0" stop-color="#B99160"/><stop offset="0.056" stop-color="#B99160"/><stop offset="0.167" stop-color="#B0895B"/><stop offset="0.278" stop-color="#A68156"/><stop offset="0.389" stop-color="#9F7B51"/><stop offset="0.5" stop-color="#9A774D"/><stop offset="0.611" stop-color="#957249"/><stop offset="0.722" stop-color="#906D45"/><stop offset="0.833" stop-color="#8C6A43"/><stop offset="0.944" stop-color="#8B6942"/><stop offset="1.0" stop-color="#8B6942"/></linearGradient></defs>`;
const MARK_PATHS =
  `<path d="M65.70 67.60 L78.30 73.90 L78.30 126.70 L65.70 120.50Z" fill="url(#ebda-mark-col)"/>` +
  `<path d="M0.00 35.80 L78.30 0.00 L78.30 74.90Z" fill="url(#ebda-mark-lint)"/>` +
  `<path d="M0.00 37.00 L42.60 58.30 L42.10 127.80 L0.20 149.00Z" fill="url(#ebda-mark-left)"/>`;

export function brandMarkSvg(opts: { size?: number; cls?: string } = {}): string {
  const h = opts.size ?? 28;
  const w = Math.round(h * 0.5255 * 100) / 100;
  const cls = opts.cls ? ` class="${opts.cls}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 78.3 149" width="${w}" height="${h}"${cls} aria-hidden="true" focusable="false">` +
    MARK_DEFS +
    MARK_PATHS +
    `</svg>`
  );
}

/**
 * The app-icon tile (night rounded square + the mark, as brand/logo/svg/05d-favicon-32.svg) as an inline SVG
 * string, for places that cannot link a file (the status page's data-URI favicon).
 */
export function brandAppIconSvg(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">` +
    `<rect width="1024" height="1024" rx="229.07" fill="${BRAND.colors.night}"/>` +
    `<g transform="translate(318.278 143.360) scale(4.94819)">${MARK_DEFS}${MARK_PATHS}</g></svg>`
  );
}

/** Free storefront hostname for a slug: `<slug>.ebda.app`. */
export function storeHost(slug: string): string {
  return `${slug.trim().toLowerCase()}${BRAND.domains.storeSuffix}`;
}

/** Free storefront origin for a slug: `https://<slug>.ebda.app`. */
export function storeOrigin(slug: string): string {
  return brandUrl(storeHost(slug));
}

/** True for `ebda.app` itself or any `*.ebda.app` host (port stripped, case-insensitive). */
export function isBrandHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === BRAND.domains.marketing || h.endsWith(BRAND.domains.storeSuffix);
}

/** RFC 5322 `From:` value, e.g. `Ebda Store <no-reply@ebda.app>` (store mail) or `Ebda AI Studio <...>` (account mail). */
export function brandFrom(displayName: string = BRAND.product.nameEn): string {
  // BRAND-NAME-1: never the bare master name as a sender (an inbox shows "Ebda", not the product).
  if (displayName.trim().toLowerCase() === 'ebda') {
    throw new Error('brandFrom: the sender name must not be the bare brand, name the product');
  }
  return `${displayName} <${BRAND.noReplyEmail}>`;
}

/** Footer line for transactional email / storefront: "Powered by Ebda Store". */
export function poweredByBrand(locale?: string | null): string {
  return locale && locale.toLowerCase().startsWith('ar')
    ? `مدعوم من ${BRAND.product.nameAr}`
    : `Powered by ${BRAND.product.nameEn}`;
}

// ---- Ebda Chat packages (Ruling WA-PRICE-1 / WA-PRICE-1a, Ahmad 2026-10-26) ----
/**
 * The Ebda Chat packages, in ONE place: the marketing pricing section and its JSON-LD read it, and the WhatsApp app
 * seeds the same ids, prices, seats and credits. Money is EGP in minor units (piastres) for ONE period: `periodMonths`
 * is 1 (monthly) or 12 (a `-yearly` package, priced at 9 months for 12, the Store rule). A yearly package carries the
 * same features as its monthly one (AI credits are still granted monthly). `features` uses the entitlement keys the
 * app enforces (deny by default): a number is a limit (`members` = team seats, `ai_credits` = AI replies a month), a
 * boolean is a switch. `store-included` is the package a Store Business plan carries (price 0, no yearly twin). Meta's
 * message fees are NOT in these prices (own number: Meta bills the card; shared number: prepaid wallet, 0% margin at
 * the moment, WA-MARGIN-1).
 */
export const WHATSAPP_YEARLY_MONTHS_PAID = 9;
export type WhatsAppBasePackageId = 'store-included' | 'starter' | 'growth' | 'pro';
export type WhatsAppPackageId =
  | WhatsAppBasePackageId
  | 'starter-yearly'
  | 'growth-yearly'
  | 'pro-yearly';
export interface WhatsAppPackageFeatures {
  members: number;
  shared_inbox: boolean;
  order_confirmations: boolean;
  templates: boolean;
  campaigns: boolean;
  order_in_chat: boolean;
  api: boolean;
  priority_support: boolean;
  ai_credits: number;
}
export interface WhatsAppPackageDef {
  id: WhatsAppPackageId;
  /** 1 = monthly, 12 = yearly. */
  periodMonths: 1 | 12;
  /** EGP piastres for one period. */
  priceMinor: number;
  features: WhatsAppPackageFeatures;
}
const WA_BASE: Record<
  WhatsAppBasePackageId,
  { priceMinor: number; features: WhatsAppPackageFeatures }
> = {
  'store-included': {
    priceMinor: 0,
    features: {
      members: 2,
      shared_inbox: true,
      order_confirmations: true,
      templates: true,
      campaigns: false,
      order_in_chat: false,
      api: false,
      priority_support: false,
      ai_credits: 100,
    },
  },
  starter: {
    priceMinor: 69000,
    features: {
      members: 2,
      shared_inbox: true,
      order_confirmations: true,
      templates: true,
      campaigns: false,
      order_in_chat: false,
      api: false,
      priority_support: false,
      ai_credits: 300,
    },
  },
  growth: {
    priceMinor: 149000,
    features: {
      members: 5,
      shared_inbox: true,
      order_confirmations: true,
      templates: true,
      campaigns: true,
      order_in_chat: true,
      api: false,
      priority_support: false,
      ai_credits: 1500,
    },
  },
  pro: {
    priceMinor: 349000,
    features: {
      members: 15,
      shared_inbox: true,
      order_confirmations: true,
      templates: true,
      campaigns: true,
      order_in_chat: true,
      api: true,
      priority_support: true,
      ai_credits: 5000,
    },
  },
};
const WA_PAID = ['starter', 'growth', 'pro'] as const;
/** The seven packages: the four monthly ones, then the three yearly twins (9x the monthly price, 12 months). */
export const WHATSAPP_PACKAGES: readonly WhatsAppPackageDef[] = [
  ...(Object.keys(WA_BASE) as WhatsAppBasePackageId[]).map(id => ({
    id,
    periodMonths: 1 as const,
    ...WA_BASE[id],
  })),
  ...WA_PAID.map(id => ({
    id: `${id}-yearly` as const,
    periodMonths: 12 as const,
    priceMinor: WA_BASE[id].priceMinor * WHATSAPP_YEARLY_MONTHS_PAID,
    features: WA_BASE[id].features,
  })),
];
/** The monthly packages, in card order. */
export const WHATSAPP_MONTHLY_PACKAGES = WHATSAPP_PACKAGES.filter(p => p.periodMonths === 1);
/** A package by id (throws on an unknown id: ids are a closed set). */
export function whatsappPackage(id: WhatsAppPackageId): WhatsAppPackageDef {
  const p = WHATSAPP_PACKAGES.find(x => x.id === id);
  if (!p) throw new Error(`unknown WhatsApp package ${id}`);
  return p;
}
/** The yearly twin of a monthly package; `store-included` has none (it stays 0 for the year). */
export function whatsappYearlyOf(id: WhatsAppBasePackageId): WhatsAppPackageDef {
  return id === 'store-included' ? whatsappPackage(id) : whatsappPackage(`${id}-yearly`);
}

// ---- ONE navigation and footer for every Ebda AI Studio surface (marketing, help, docs, status) ----
/**
 * The ONE navigation and footer data of the five Ebda AI Studio sites (ruling NAV-PRODUCT-OF-PAGE-1, NAV-CTA-1,
 * NAV-CHAT-SLUG-1; public sites audit 2026-11-03 section 4). Everything a header or footer shows (labels, hrefs, order,
 * groups, ar and en) is returned by the functions below, and two renderers draw it: the marketing site's React
 * `Header`/`Footer` and the string renderers here (`siteNavHtml`, `siteFooterHtml`) used by help, docs and status.
 * `tests/unit/studio-nav-footer.test.ts` compares the two so they cannot drift.
 *
 * The studio bar is on every page: wordmark (always the studio home), Products, Resources, About, Contact, Log in,
 * the studio CTA. A product bar (`productBar`) sits under it only on a product page. The footer is the same five
 * columns everywhere. Pure strings, no imports beyond this module (the status Worker may import nothing else, and the
 * docs and help builders load it as bare TypeScript through Node, which cannot resolve an extensionless sibling).
 */
export type NavLang = 'ar' | 'en';
/** The site a page belongs to: its Resources link gets `aria-current="page"`. `null` = none (a marketing page). */
export type NavSite = 'docs' | 'help' | 'status';
/** Which product a marketing page belongs to; `studio` shows no product bar. */
export type NavKind = 'studio' | 'store' | 'chat';

/** One link. `href` is absolute (support sites render it as is); `path` is the same-origin marketing path when the target is a marketing page (the marketing site routes it with next/link). */
export interface NavLink {
  id: string;
  label: string;
  href: string;
  path?: string;
}
export type SiteNavProductId = 'store' | 'whatsapp';
export interface SiteNavProduct extends NavLink {
  id: SiteNavProductId;
  blurb: string;
}

/**
 * The Products menu icons (24x24, drawn once, stroked in the panel's gold on a night tile). `fill: true` paths are
 * solid. The marketing header renders the same paths in React, the support sites through `siteNavIconSvg`.
 */
export const SITE_NAV_ICONS: Record<SiteNavProductId, readonly { d: string; fill?: boolean }[]> = {
  store: [
    {
      d: 'M4 9.5 5.5 4h13L20 9.5M4 9.5a2.67 2.67 0 0 0 5.33 0 2.67 2.67 0 0 0 5.34 0 2.67 2.67 0 0 0 5.33 0M5.5 12.6V20h13v-7.4M10 20v-4.6h4V20',
    },
  ],
  // Ebda Chat (Ruling MKT-HOME-APPROVED-1): two message cards, the customer's behind and the store's reply in front. A conversation, never
  // WhatsApp's circle bubble with a handset (Meta brand rules). Same grid, 1.7 stroke and round joins as the Store icon. It mirrors in Arabic.
  whatsapp: [
    {
      d: 'M17 10.5V6.8a2.3 2.3 0 0 0-2.3-2.3H6.8a2.3 2.3 0 0 0-2.3 2.3v6.4a2.3 2.3 0 0 0 2.3 2.3h1.1',
    },
    {
      d: 'M10.8 10.5h6.4a2.3 2.3 0 0 1 2.3 2.3v3.4a2.3 2.3 0 0 1-2.3 2.3h-4.4l-2.6 2.1v-2.1a2.3 2.3 0 0 1-2.3-2.3v-3.4a2.3 2.3 0 0 1 2.3-2.3Z',
    },
    { d: 'M11.9 14.5h4.8' },
  ],
};

const L = (lang: NavLang, ar: string, en: string) => (lang === 'ar' ? ar : en);
/** A marketing path for a locale: Arabic at the root, English under /en (`/` becomes `/en/`). */
const mpath = (lang: NavLang, p: string) => `${lang === 'ar' ? '' : '/en'}${p}`;
const marketing = (lang: NavLang) => `${BRAND_MARKETING_URL}${mpath(lang, '/')}`;
const mlink = (lang: NavLang, id: string, label: string, p: string): NavLink => ({
  id,
  label,
  path: mpath(lang, p),
  href: `${BRAND_MARKETING_URL}${mpath(lang, p)}`,
});
const studioName = (lang: NavLang) =>
  lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;

/** The studio security mailbox (security.txt, the footer, the contact page). */
export const BRAND_SECURITY_EMAIL = `security@${BRAND.domains.marketing}`;

/** The studio home of a language (the wordmark target everywhere). */
export function studioHomeLink(lang: NavLang): NavLink {
  return mlink(lang, 'studio', studioName(lang), '/');
}

/**
 * The Products menu: only live products (BRAND-ARCH-1), Ebda Store then Ebda Chat. Ebda Chat's page stays at
 * /whatsapp (NAV-CHAT-SLUG-1); /chat is a redirect alias. Product names never carry "WhatsApp".
 */
export function siteNavProducts(lang: NavLang): SiteNavProduct[] {
  return [
    {
      ...mlink(
        lang,
        'store',
        lang === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn,
        '/store/'
      ),
      id: 'store',
      blurb: L(lang, 'متجرك أونلاين في دقايق', 'Your online store in minutes'),
    },
    {
      ...mlink(
        lang,
        'whatsapp',
        lang === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn,
        '/whatsapp/'
      ),
      id: 'whatsapp',
      blurb: L(
        lang,
        'كلّم عملاءك على واتساب من مكان واحد',
        'Talk to your customers on WhatsApp, from one inbox'
      ),
    },
  ];
}

/** The Resources menu: Help centre, Docs, Service status, each in the page's language (docs: English at the root; help and status: Arabic at the root). */
export function siteNavResources(lang: NavLang): (NavLink & { id: NavSite })[] {
  const d = BRAND.domains;
  return [
    {
      id: 'help',
      href: `https://${d.help}/${lang === 'ar' ? '' : 'en/'}`,
      label: L(lang, 'مركز المساعدة', 'Help centre'),
    },
    {
      id: 'docs',
      href: `https://${d.docs}/${lang === 'ar' ? 'ar/' : ''}`,
      label: L(lang, 'الوثائق', 'Docs'),
    },
    {
      id: 'status',
      href: `https://${d.status}/${lang === 'ar' ? '' : 'en'}`,
      label: L(lang, 'حالة الخدمة', 'Service status'),
    },
  ];
}

/** The studio's own pages: About, Contact. */
export function siteNavStudio(lang: NavLang): NavLink[] {
  return [
    mlink(lang, 'about', L(lang, 'عن ابدأ ستوديو', 'About the studio'), '/about/'),
    mlink(lang, 'contact', L(lang, 'تواصل معنا', 'Contact'), '/contact/'),
  ];
}

/** Every destination of the studio bar as one flat list (the 404 pages' site map): studio home, products, resources, About, Contact. */
export function siteNavMap(lang: NavLang): NavLink[] {
  return [
    studioHomeLink(lang),
    ...siteNavProducts(lang),
    ...siteNavResources(lang),
    ...siteNavStudio(lang),
  ];
}

/** Log in: one label, and one labelled entry per product until the shared accounts sign-in has its own page (audit P1-6). */
export function siteNavLogin(
  lang: NavLang,
  kind: NavKind = 'studio'
): { label: string; items: NavLink[] } {
  const items: NavLink[] = [
    {
      id: 'store',
      label: L(lang, 'دخول ابدأ ستور', 'Log in to Ebda Store'),
      href: `${BRAND_STORE_APP_URL}/login`,
    },
    {
      id: 'whatsapp',
      label: L(lang, 'دخول ابدأ شات', 'Log in to Ebda Chat'),
      href: brandUrl(BRAND.domains.whatsappApp),
    },
  ];
  // a product page logs in to its own product only (MKT-WA-CHROME-1: a Chat page never sends a visitor to the Store app)
  return {
    label: L(lang, 'دخول', 'Log in'),
    items:
      kind === 'studio'
        ? items
        : items.filter(i => i.id === (kind === 'store' ? 'store' : 'whatsapp')),
  };
}

/** The studio CTA (NAV-CTA-1): choose a product, anchored to the product windows of the studio home. */
export function siteNavCta(lang: NavLang): NavLink {
  return {
    id: 'cta',
    label: L(lang, 'اختار منتجك', 'Choose a product'),
    path: `${mpath(lang, '/')}#products`,
    href: `${marketing(lang)}#products`,
  };
}

/** The labels of the groups, shared by both renderers. */
export const siteNavLabels = (lang: NavLang) => ({
  nav: L(lang, 'التنقل الرئيسي', 'Main navigation'),
  products: L(lang, 'المنتجات', 'Products'),
  resources: L(lang, 'المصادر', 'Resources'),
  studio: L(lang, 'الستوديو', 'Studio'),
  menu: L(lang, 'القائمة', 'Menu'),
});

/**
 * The product bar under the studio bar, only on a product page: the product chip (links to the product's page), its own
 * sections and its own CTA. Store anchors are written `/store/#id` (one hop, audit P1-10).
 */
export function productBar(
  kind: Exclude<NavKind, 'studio'>,
  lang: NavLang
): { chip: NavLink; links: NavLink[]; cta: NavLink } {
  if (kind === 'store') {
    return {
      chip: mlink(
        lang,
        'store',
        lang === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn,
        '/store/'
      ),
      links: [
        mlink(lang, 'story', L(lang, 'إزاي بيشتغل', 'How it works'), '/store/#story'),
        mlink(lang, 'looks', L(lang, 'القوالب', 'Templates'), '/store/#looks'),
        mlink(lang, 'features', L(lang, 'المميزات', 'Features'), '/features/'),
        mlink(lang, 'pricing', L(lang, 'الأسعار', 'Pricing'), '/store/#pricing'),
        mlink(lang, 'faq', L(lang, 'أسئلة', 'FAQ'), '/store/#faq'),
      ],
      cta: {
        id: 'cta',
        label: L(lang, 'افتح متجرك', 'Open your store'),
        href: `${BRAND_STORE_APP_URL}/signup`,
      },
    };
  }
  return {
    chip: mlink(
      lang,
      'whatsapp',
      lang === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn,
      '/whatsapp/'
    ),
    links: [
      mlink(lang, 'features', L(lang, 'المميزات', 'Features'), '/whatsapp/#features'),
      mlink(lang, 'pricing', L(lang, 'الأسعار', 'Pricing'), '/whatsapp/#pricing'),
      mlink(lang, 'faq', L(lang, 'أسئلة', 'FAQ'), '/whatsapp/#faq'),
    ],
    cta: {
      id: 'cta',
      label: L(lang, 'ابدأ مع ابدأ شات', 'Start with Ebda Chat'),
      href: brandUrl(BRAND.domains.whatsappApp),
    },
  };
}

export interface SiteFooterColumn {
  id: 'products' | 'resources' | 'studio' | 'legal';
  title: string;
  links: (NavLink & { action?: 'cookies' })[];
}
/**
 * The footer, identical on all five sites: the brand column (name, one-line mission, mailboxes, WhatsApp number) and
 * four link columns (Products, Resources, Studio, Legal). No competitor compare links (Ahmad 2026-10-23). The legal
 * entity's full name is not here: it lives on the legal pages only (AR-STUDIO-NAME-1).
 */
export function siteFooter(lang: NavLang): {
  label: string;
  brand: {
    name: string;
    mission: string;
    contacts: { id: string; label: string; value: string; href: string }[];
  };
  columns: SiteFooterColumn[];
  copyright: (year: number) => string;
} {
  const products = siteNavProducts(lang);
  const [storeProduct, chatProduct] = products as [SiteNavProduct, SiteNavProduct];
  const resources = siteNavResources(lang);
  const about = siteNavStudio(lang);
  const m = (id: string, label: string, p: string) => mlink(lang, id, label, p);
  return {
    label: L(lang, 'روابط الموقع', 'Site links'),
    brand: {
      name: studioName(lang),
      mission: L(lang, 'بابك لبدء مشروعك.', 'Your doorway to business.'),
      contacts: [
        {
          id: 'hello',
          label: L(lang, 'أسئلة واستفسارات', 'Questions and help'),
          value: BRAND.supportEmail,
          href: `mailto:${BRAND.supportEmail}`,
        },
        {
          id: 'security',
          label: L(lang, 'الإبلاغ عن ثغرة أمنية', 'Report a security issue'),
          value: BRAND_SECURITY_EMAIL,
          href: `mailto:${BRAND_SECURITY_EMAIL}`,
        },
        {
          id: 'whatsapp',
          label: L(lang, 'واتساب', 'WhatsApp'),
          value: whatsappDisplay(),
          href: whatsappUrl(),
        },
      ],
    },
    columns: [
      {
        id: 'products',
        title: siteNavLabels(lang).products,
        links: [
          storeProduct,
          m('store-features', L(lang, 'مميزات ابدأ ستور', 'Ebda Store features'), '/features/'),
          m('store-pricing', L(lang, 'أسعار ابدأ ستور', 'Ebda Store pricing'), '/store/#pricing'),
          m('store-templates', L(lang, 'قوالب ابدأ ستور', 'Ebda Store templates'), '/store/#looks'),
          chatProduct,
          m('chat-pricing', L(lang, 'أسعار ابدأ شات', 'Ebda Chat pricing'), '/whatsapp/#pricing'),
        ],
      },
      {
        id: 'resources',
        title: siteNavLabels(lang).resources,
        links: [
          ...resources,
          m('credits', L(lang, 'حقوق الصور والموديلات', 'Credits'), '/credits/'),
        ],
      },
      {
        id: 'studio',
        title: siteNavLabels(lang).studio,
        links: [
          ...about,
          {
            id: 'security-txt',
            label: 'security.txt',
            href: `${BRAND_MARKETING_URL}/.well-known/security.txt`,
            path: '/.well-known/security.txt',
          },
        ],
      },
      {
        id: 'legal',
        title: L(lang, 'قانوني', 'Legal'),
        links: [
          m('legal', L(lang, 'الإشعار القانوني', 'Legal notice'), '/legal/'),
          m('privacy', L(lang, 'الخصوصية', 'Privacy'), '/privacy/'),
          m('terms', L(lang, 'الشروط', 'Terms'), '/terms/'),
          m(
            'merchant',
            L(lang, 'اتفاقية التاجر لابدأ ستور', 'Ebda Store merchant agreement'),
            '/merchant-agreement/'
          ),
          m('acceptable-use', L(lang, 'الاستخدام المقبول', 'Acceptable use'), '/acceptable-use/'),
          m('refund', L(lang, 'استرداد ابدأ ستور', 'Ebda Store refunds'), '/refund/'),
          m('data-deletion', L(lang, 'حذف البيانات', 'Data deletion'), '/legal/data-deletion/'),
          m('chat-terms', L(lang, 'شروط ابدأ شات', 'Ebda Chat terms'), '/legal/whatsapp-terms/'),
          m(
            'chat-privacy',
            L(lang, 'خصوصية ابدأ شات', 'Ebda Chat privacy'),
            '/legal/whatsapp-privacy/'
          ),
          m(
            'chat-dpa',
            L(lang, 'اتفاقية معالجة بيانات ابدأ شات', 'Ebda Chat DPA'),
            '/legal/whatsapp-dpa/'
          ),
          {
            ...m('cookies', L(lang, 'إعدادات الكوكيز', 'Cookie settings'), '/privacy/'),
            action: 'cookies',
          },
        ],
      },
    ],
    copyright: year =>
      L(
        lang,
        `© ${year} ${BRAND.company.shortNameAr}. جميع الحقوق محفوظة.`,
        `© ${year} ${BRAND.company.shortNameEn}. All rights reserved.`
      ),
  };
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

/** The studio lockup: mark + the master brand name + the site name. `markHtml` is the caller's icon (an <img> or inline SVG). The href is the studio home, always. */
export function siteWordmarkHtml(p: {
  lang: NavLang;
  href: string;
  siteLabel: string;
  markHtml: string;
}): string {
  return `<a class="wordmark" href="${esc(p.href)}">${p.markHtml}<span>${esc(studioName(p.lang))}</span><span class="wm-site">${esc(p.siteLabel)}</span></a>`;
}

/** The icon as an inline <svg> string (decorative). */
export function siteNavIconSvg(id: SiteNavProductId, lang?: NavLang): string {
  const paths = SITE_NAV_ICONS[id]
    .map(p =>
      p.fill
        ? `<path d="${p.d}" fill="currentColor"/>`
        : `<path d="${p.d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('');
  const mirror = lang === 'ar' && id === 'whatsapp' ? ' style="transform:scaleX(-1)"' : '';
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"${mirror}>${paths}</svg>`;
}

/**
 * The studio bar's navigation for the support sites: desktop link row with the Products, Resources and Log in
 * disclosures, About, Contact and the CTA, and the mobile menu grouped Products / Resources / Studio (below 1180px
 * it collapses into the menu button; wider, it is its own row under the wordmark, search and language switch).
 */
export function siteNavHtml(lang: NavLang, active: NavSite | null): string {
  const t = siteNavLabels(lang);
  const products = siteNavProducts(lang);
  const resources = siteNavResources(lang);
  const studio = siteNavStudio(lang);
  const login = siteNavLogin(lang);
  const cta = siteNavCta(lang);
  const a = (i: NavLink, cls = '') =>
    `<a href="${esc(i.href)}"${cls ? ` class="${cls}"` : ''}${i.id === active ? ' aria-current="page"' : ''}>${esc(i.label)}</a>`;
  const li = (i: NavLink) => `<li>${a(i)}</li>`;
  // one card per product: icon tile, full name, one-sentence blurb (the marketing header renders the same pieces in React)
  const prod = (p: SiteNavProduct) =>
    `<li><a href="${esc(p.href)}"><span class="np-ico">${siteNavIconSvg(p.id, lang)}</span><span class="np-txt"><b>${esc(p.label)}</b><span>${esc(p.blurb)}</span></span></a></li>`;
  const menu = (title: string, items: string) =>
    `<li class="nav-products"><details><summary>${esc(title)}</summary><ul>${items}</ul></details></li>`;
  const group = (title: string, links: NavLink[]) =>
    `<li class="menu-group"><p>${esc(title)}</p><ul>${links.map(li).join('')}</ul></li>`;
  return (
    `<nav class="top-nav" aria-label="${esc(t.nav)}">` +
    `<ul class="nav-links">` +
    menu(t.products, products.map(prod).join('')) +
    menu(t.resources, resources.map(li).join('')) +
    studio.map(li).join('') +
    `<li class="nav-end"></li>` +
    menu(login.label, login.items.map(li).join('')) +
    `<li>${a(cta, 'nav-cta')}</li>` +
    `</ul>` +
    `<details class="nav-menu"><summary><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg><span>${esc(t.menu)}</span></summary>` +
    `<ul>${group(t.products, products)}${group(t.resources, resources)}${group(t.studio, studio)}${group(login.label, login.items)}<li class="menu-cta">${a(cta, 'nav-cta')}</li></ul></details>` +
    `</nav>`
  );
}

const colHtml = (c: SiteFooterColumn) =>
  `<nav class="sf-col" aria-labelledby="sf-${c.id}"><h2 id="sf-${c.id}">${esc(c.title)}</h2><ul>${c.links
    .map(l => `<li><a href="${esc(l.href)}">${esc(l.label)}</a></li>`)
    .join('')}</ul></nav>`;

/** The footer for the support sites: the same data as the marketing React `Footer`. `markHtml` is the caller's icon. */
export function siteFooterHtml(lang: NavLang, markHtml: string, year: number): string {
  const f = siteFooter(lang);
  const contacts = f.brand.contacts
    .map(
      c =>
        `<div><dt>${esc(c.label)}</dt><dd><a href="${esc(c.href)}"${c.id === 'whatsapp' ? ' dir="ltr"' : ''}>${esc(c.value)}</a></dd></div>`
    )
    .join('');
  return (
    `<footer class="site-footer band-dark sf"><div class="wrap">` +
    `<div class="sf-grid"><div class="sf-brand"><p class="sf-name">${markHtml}<span>${esc(f.brand.name)}</span></p><p class="sf-mission">${esc(f.brand.mission)}</p><dl class="sf-contact">${contacts}</dl></div>` +
    f.columns.map(colHtml).join('') +
    `</div><div class="sf-bottom"><p class="muted small">${esc(f.copyright(year))}</p></div></div></footer>`
  );
}

/**
 * The Products panel (desktop) and the mobile menu's Products group, as CSS: one card per product, anchored to its
 * trigger with logical properties (so it mirrors in Arabic RTL). It reads only --fg, --muted, --line and --panel, which
 * every Ebda site defines, plus the brand night and gold for the icon tile. The marketing site's globals.css carries
 * the same block between `nav-products:start` and `nav-products:end` (tests/unit/site-nav-shared.test.ts keeps them equal).
 */
export const SITE_NAV_PANEL_CSS = `
.nav-products{position:relative}
.nav-products>details>ul{position:absolute;inset-inline-start:-18px;top:100%;z-index:60;margin:8px 0 0;padding:8px;list-style:none;width:min(340px,calc(100vw - 32px));background:var(--panel);border:1px solid var(--line);border-radius:14px}
.nav-products li a{display:flex;align-items:center;gap:12px;padding:10px;min-height:44px;border-radius:10px;color:var(--fg);text-decoration:none}
.nav-products li a:hover,.nav-products li a:focus-visible{background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--fg)}
.np-ico{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:${BRAND.colors.night};color:${BRAND.colors.gold}}
.np-txt{display:grid;gap:2px;min-width:0}
.np-txt b{font-weight:600;line-height:1.35}
.np-txt span{color:var(--muted);font-size:.875rem;line-height:1.5}
.menu-group>p{margin:0;padding:6px var(--np-inset,10px);color:var(--muted);font-size:.8125rem;font-weight:600}
`.replace(/\n/g, '');

/**
 * The keyboard and close behaviour of the header's two <details> menus (the Products panel and the mobile menu), as one
 * framework-free script, shared by marketing, docs, help and status. Every site serves it as a same-origin static file
 * (`/assets/site-nav.js`, marketing `/site-nav.js`); there is no inline code, so a strict CSP (`script-src 'self'`)
 * stays valid. The markup works without it (plain <details>); the script only adds:
 *   - Esc closes the open menu and returns focus to its trigger;
 *   - a pointer or focus outside an open menu closes it;
 *   - opening one menu closes the other;
 *   - a plain link click inside closes it (a ctrl/cmd/shift/middle click leaves the page where it is, so it stays);
 *   - aria-expanded on the trigger, kept in step with the open state.
 * The source is plain ES5 so no build step touches it. tests/unit/site-nav-behaviour.test.ts runs it in jsdom against
 * every site's real header and checks each site serves exactly this text.
 */
export const SITE_NAV_JS = `(function () {
  var header = document.querySelector('.site-header');
  if (!header) return;
  function menus() {
    return Array.prototype.slice.call(header.querySelectorAll('details'));
  }
  function trigger(d) {
    for (var i = 0; i < d.children.length; i++)
      if (d.children[i].tagName === 'SUMMARY') return d.children[i];
    return null;
  }
  function sync(d) {
    var t = trigger(d);
    if (t) t.setAttribute('aria-expanded', String(d.open));
  }
  function closeAll(except) {
    menus().forEach(function (d) {
      if (d !== except && d.open) d.open = false;
    });
  }
  function outside(e) {
    menus().forEach(function (d) {
      if (d.open && !d.contains(e.target)) d.open = false;
    });
  }
  menus().forEach(sync);
  header.addEventListener(
    'toggle',
    function (e) {
      var d = e.target;
      if (!d || d.tagName !== 'DETAILS') return;
      sync(d);
      if (d.open) closeAll(d);
    },
    true
  );
  header.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target.closest ? e.target.closest('a') : null;
    var d = a && a.closest('details');
    if (d && header.contains(d)) d.open = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = menus().filter(function (d) {
      return d.open;
    })[0];
    if (!open) return;
    open.open = false;
    var t = trigger(open);
    if (t) t.focus();
  });
  document.addEventListener('pointerdown', outside);
  document.addEventListener('focusin', outside);
})();
`;

/** Stylesheet for the wordmark and the nav above. Uses the sites' shared tokens (--fg --muted --line --lift --panel --night). */
export const SITE_NAV_CSS =
  `
.top-nav{order:3;flex:1 1 100%;min-width:0;position:relative}
.top-nav ul{list-style:none;margin:0;padding:0}
.top-nav .nav-links{display:flex;flex-wrap:nowrap;align-items:center;gap:4px 16px;white-space:nowrap}
.top-nav .nav-end{flex:1 1 0}
.top-nav a{color:var(--fg);text-decoration:none;padding:6px 2px;display:inline-block}
.top-nav a:hover{color:var(--accent-text,var(--lift))}
.top-nav a[aria-current=page]{color:var(--accent-text,var(--lift));border-bottom:2px solid var(--accent-text,var(--lift))}
.top-nav a.nav-cta{background:var(--gold);color:var(--night);border-radius:10px;padding:8px 14px;font-weight:600;border-bottom:0}
.top-nav a.nav-cta:hover{background:var(--lift);color:var(--night)}
.top-nav summary{cursor:pointer;list-style:none;color:var(--fg);padding:6px 2px;display:inline-flex;align-items:center;gap:6px;min-height:44px}
.top-nav summary::-webkit-details-marker{display:none}
.nav-products>details>summary::after{content:"";width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);margin-block-start:-3px}
.nav-end~.nav-products>details>ul{inset-inline-start:auto;inset-inline-end:-18px}
.nav-menu>ul{position:absolute;z-index:60;min-width:230px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;margin-block-start:6px}
.nav-menu{display:none}
.nav-menu>ul a{display:block;padding:10px;min-height:44px}
.nav-menu .menu-group+.menu-group{border-top:1px solid var(--line);margin-top:4px;padding-top:4px}
.nav-menu .menu-cta{padding:8px 0 0}.nav-menu a.nav-cta{text-align:center}
@media (max-width:1179px){.top-nav{order:0;flex:0 0 auto;margin-inline-start:auto}.top-nav .nav-links{display:none}.nav-menu{display:block}}
`.replace(/\n/g, '') + SITE_NAV_PANEL_CSS;

// ---- Islamic geometry for help, docs and status (static SVG, no script) ----
/**
 * The same motif family as the marketing site (`apps/marketing/public/motifs/*`: Ebda gold, brass and silver, the 8-fold star
 * and the 12-point star, never a {6/2} hexagram, ruling MKT-NO-HEXAGRAM-1), generated here as pure strings so that the
 * status Worker (which may import only this module) and the docs/help builds draw it without a file copy or a request.
 * Every star is a single closed polygon of 16 or 24 vertices; the guard in tests/unit/marketing-no-hexagram.test.ts reads
 * `SITE_ART_SVGS`. Light ground by default (`dark` raises the strokes for the night footer band).
 */
const ART_GOLD = BRAND.colors.gold;
const ART_BRASS = '#8A6A36';
const ART_SILVER = '#7D858D';
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
/** A closed star polygon: `n` tips, outer radius `ro`, inner radius `ri`, first tip pointing up. */
function artStar(cx: number, cy: number, n: number, ro: number, ri: number): string {
  const pts: string[] = [];
  for (let k = 0; k < n * 2; k++) {
    const a = (k * Math.PI) / n - Math.PI / 2;
    const r = k % 2 ? ri : ro;
    pts.push(`${f1(cx + Math.cos(a) * r)} ${f1(cy + Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
}
/** A closed regular polygon (the octagon ring). */
function artPoly(cx: number, cy: number, n: number, r: number, rot = 0): string {
  const pts: string[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k * 2 * Math.PI) / n - Math.PI / 2 + rot;
    pts.push(`${f1(cx + Math.cos(a) * r)} ${f1(cy + Math.sin(a) * r)}`);
  }
  return `M${pts.join('L')}Z`;
}
const stroke = (d: string, c: string, o: number, w = 1) =>
  `<path d='${d}' fill='none' stroke='${c}' stroke-opacity='${o}' stroke-width='${w}' stroke-linejoin='round'/>`;
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`;
const ring = (c: number, r: number, color: string, o: number) =>
  `<circle cx='${c}' cy='${c}' r='${r}' fill='none' stroke='${color}' stroke-opacity='${o}'/>`;

/** The medallions (44x44): 8-fold star, 12-point star, quatrefoil, octagon ring. */
const medallion = {
  m8: svg(
    44,
    44,
    ring(22, 20, ART_GOLD, 0.5) +
      stroke(artStar(22, 22, 8, 15, 9.6), ART_GOLD, 0.9) +
      stroke(artStar(22, 22, 8, 8.4, 5.4), ART_SILVER, 0.9) +
      `<circle cx='22' cy='22' r='1.4' fill='${ART_BRASS}'/>`
  ),
  m12: svg(
    44,
    44,
    ring(22, 20, ART_GOLD, 0.5) +
      stroke(artStar(22, 22, 12, 16, 11.4), ART_GOLD, 0.9) +
      stroke(artStar(22, 22, 12, 8, 5.6), ART_SILVER, 0.9) +
      `<circle cx='22' cy='22' r='1.4' fill='${ART_BRASS}'/>`
  ),
  // quatrefoil: four lobes, each a circle arc, meeting at the centre
  mq: svg(
    44,
    44,
    ring(22, 20, ART_GOLD, 0.5) +
      stroke(
        'M22 8A7 7 0 0 1 36 22A7 7 0 0 1 22 36A7 7 0 0 1 8 22A7 7 0 0 1 22 8Z',
        ART_GOLD,
        0.9
      ) +
      stroke(artPoly(22, 22, 4, 7, Math.PI / 4), ART_SILVER, 0.9) +
      `<circle cx='22' cy='22' r='1.4' fill='${ART_BRASS}'/>`
  ),
  mo: svg(
    44,
    44,
    stroke(artPoly(22, 22, 8, 20, Math.PI / 8), ART_GOLD, 0.7) +
      stroke(artPoly(22, 22, 8, 14, 0), ART_SILVER, 0.9) +
      `<circle cx='22' cy='22' r='4.2' fill='none' stroke='${ART_BRASS}' stroke-opacity='.9'/>`
  ),
};
const strip = (c: string, o: number) =>
  svg(
    40,
    16,
    stroke(artStar(10, 8, 8, 7, 4.4), c, o) +
      stroke('M35 8L30 13L25 8L30 3Z', c, o) +
      `<path d='M17 8H25M35 8H40M0 8H3' stroke='${c}' stroke-opacity='${o}'/>`
  );
const TESS_STARS: [number, number][] = [
  [48, 48],
  [0, 0],
  [96, 0],
  [0, 96],
  [96, 96],
];
const TESS_DIAMONDS: [number, number][] = [
  [48, 0],
  [0, 48],
  [96, 48],
  [48, 96],
];
const tess = svg(
  96,
  96,
  TESS_STARS.map(([x, y]) => stroke(artStar(x, y, 8, 30, 19), ART_GOLD, 0.2)).join('') +
    TESS_DIAMONDS.map(([x, y]) => stroke(artPoly(x, y, 4, 12, 0), ART_SILVER, 0.2)).join('')
);
/** Every SVG the support sites draw, raw (the no-hexagram guard reads these). */
export const SITE_ART_SVGS = {
  ...medallion,
  strip: strip(ART_GOLD, 0.8),
  stripDark: strip(BRAND.colors.lift, 0.75),
  tess,
} as const;
const uri = (x: string) =>
  `url("data:image/svg+xml,${x.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`;

/**
 * The art as CSS: a gold strip under the header, a strip on the footer band, medallion dividers (`<div class="medal m8">`
 * etc., decorative), and a faint tessellation watermark on landing and index pages (`.tess`). Static data-URI SVG, no
 * request and no JS. Purely decorative (aria-hidden, no text), so it carries no contrast duty.
 */
export const SITE_ART_CSS = `
.site-header::after{content:"";display:block;height:10px;background:${uri(SITE_ART_SVGS.strip)} center/25px 10px repeat-x}
.sf{position:relative}
.sf::before{content:"";position:absolute;inset-inline:0;top:0;height:16px;background:${uri(SITE_ART_SVGS.stripDark)} center/40px 16px repeat-x}
.medal{position:relative;height:44px;margin:40px auto;max-width:520px;background:var(--medal) center/44px 44px no-repeat}
.medal::before,.medal::after{content:"";position:absolute;top:50%;height:1px;width:calc(50% - 34px);background:linear-gradient(90deg,transparent,${ART_GOLD})}
.medal::before{inset-inline-start:0}
.medal::after{inset-inline-end:0;transform:scaleX(-1)}
.medal.m8{--medal:${uri(SITE_ART_SVGS.m8)}}
.medal.m12{--medal:${uri(SITE_ART_SVGS.m12)}}
.medal.mq{--medal:${uri(SITE_ART_SVGS.mq)}}
.medal.mo{--medal:${uri(SITE_ART_SVGS.mo)}}
.tess{background-image:${uri(SITE_ART_SVGS.tess)};background-size:96px 96px}
`.replace(/\n/g, '');

/** A decorative medallion divider for a page body: one of the four motifs. */
export function siteMedalHtml(kind: 'm8' | 'm12' | 'mq' | 'mo' = 'm8'): string {
  return `<div class="medal ${kind}" role="presentation" aria-hidden="true"></div>`;
}

/**
 * The footer's stylesheet, shared by marketing (inlined by its `Footer`) and docs, help and status (appended to their
 * site stylesheets). A deliberately dark band whatever the page's ground: it defines its own tokens. Five columns from
 * 900px (brand + four link columns), two columns on a phone; logical properties, so it mirrors in Arabic.
 */
export const SITE_FOOTER_CSS = `
.band-dark{--canvas:${BRAND.colors.night};--panel:#121415;--raise:#181b1c;--line:#2f3435;--line-strong:#6f7775;--fg:#f3f5f4;--muted:#a9b1af;--accent-text:${BRAND.colors.lift};background:${BRAND.colors.night};color:#f3f5f4}
.sf{margin-top:56px;padding-block:44px 24px}
.sf a{color:#f3f5f4;text-decoration:none}
.sf a:hover{color:${BRAND.colors.lift};text-decoration:underline;text-underline-offset:3px}
.sf-grid{display:grid;gap:32px 24px;grid-template-columns:repeat(2,minmax(0,1fr))}
.sf-brand{grid-column:1/-1}
@media (min-width:900px){.sf-grid{grid-template-columns:minmax(220px,1.4fr) repeat(4,minmax(0,1fr))}.sf-brand{grid-column:auto}}
.sf-name{display:flex;align-items:center;gap:10px;font-weight:600;margin:0 0 6px}
.sf-mission{color:#a9b1af;margin:0 0 16px}
.sf-contact{margin:0;display:grid;gap:10px}
.sf-contact dt{color:#a9b1af;font-size:.8125rem}
.sf-contact dd{margin:0}
.sf-col h2{font-size:.8125rem;font-weight:600;letter-spacing:.04em;color:${BRAND.colors.lift};margin:0 0 10px}
html[lang=ar] .sf-col h2{letter-spacing:0}
.sf-col ul{list-style:none;margin:0;padding:0;display:grid}
.sf-col a,.sf-col button{display:inline-block;padding:9px 0;min-height:44px;color:#f3f5f4;background:none;border:0;font:inherit;text-align:start;cursor:pointer}
.sf-col button:hover{color:${BRAND.colors.lift};text-decoration:underline;text-underline-offset:3px}
.sf-bottom{border-top:1px solid #2f3435;margin-top:32px;padding-top:16px}
.sf-bottom p{margin:0;color:#a9b1af}
`.replace(/\n/g, '');
