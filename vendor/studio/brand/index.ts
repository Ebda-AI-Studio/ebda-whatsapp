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
  nameAr: 'ابدأ استوديو للذكاء الاصطناعي',
  /**
   * The PRODUCT (the store builder). `name`/`nameAr` above name the company; anything naming the product or the Service
   * reads this (ruling PRODUCT-NAME-1). Future products: Ebda WhatsApp / CRM / ERP.
   */
  product: {
    nameEn: 'Ebda Store',
    nameAr: 'ابدأ ستور',
  },
  /**
   * The WhatsApp PRODUCT (Ebda WhatsApp, by Ebda AI Studio): always the full name, never a bare "Ebda" (BRAND-NAME-1).
   * Lives at `domains.whatsappApp`; its marketing page is /whatsapp on the marketing site.
   */
  productWhatsapp: {
    nameEn: 'Ebda WhatsApp',
    nameAr: 'ابدأ واتساب',
  },
  /** The company behind Ebda (single source for every operator mention; ruling OPERATOR-1). */
  company: {
    legalNameAr: 'ابدأ استوديو للذكاء الاصطناعي والبرمجيات والتسويق الرقمي',
    legalNameEn: 'Ebda AI Studio for Artificial Intelligence, Software and Digital Marketing',
    shortNameAr: 'ابدأ استوديو للذكاء الاصطناعي',
    shortNameEn: 'Ebda AI Studio',
    url: 'https://ebda.app',
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
    /** The Ebda WhatsApp app (LAUNCH-SUITE-1; its Worker's custom domain). */
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

// ---- Ebda WhatsApp packages (Ruling WA-PRICE-1 / WA-PRICE-1a, Ahmad 2026-10-26) ----
/**
 * The Ebda WhatsApp packages, in ONE place: the marketing pricing section and its JSON-LD read it, and the WhatsApp app
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

// ---- shared header navigation of the support sites (docs, help, status) ----
/**
 * The ONE header navigation of the three Ebda AI Studio support sites (docs, help, status): the wordmark lockup, the
 * Products menu, the five site links and the mobile menu. docs and help render it through packages/site-kit's page
 * shell, status through its own Worker renderer; both call these functions, so the three always show the same links,
 * in the same order, with the same labels in ar and en. Pure strings, no imports beyond the brand module (the status
 * Worker may import nothing else). It lives inside the brand module on purpose: the docs and help builders load it as bare TypeScript through Node, which
 * cannot resolve an extensionless sibling import, and the status Worker may import this module only.
 */
export type NavLang = 'ar' | 'en';
/** The site a page belongs to: its link gets `aria-current="page"`. `null` = none (a page of another site). */
export type NavSite = 'studio' | 'dashboard' | 'docs' | 'help' | 'status';

export interface SiteNavItem {
  id: NavSite;
  href: string;
  label: string;
}
export type SiteNavProductId = 'store' | 'whatsapp';
export interface SiteNavProduct {
  id: SiteNavProductId;
  href: string;
  label: string;
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
  whatsapp: [
    { d: 'M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5Z' },
    {
      d: 'M9.2 8.6c.2-.4.5-.4.7-.4l.5.1.8 1.8c0 .2 0 .4-.2.6l-.5.6c.6 1.1 1.5 2 2.6 2.6l.6-.6c.2-.2.4-.2.6-.1l1.7.8c.1.3.1.6 0 .9-.3.8-1.3 1.2-2.2 1-2.6-.7-4.5-2.6-5.2-5.2-.1-.6.1-1.5 1-2.1Z',
      fill: true,
    },
  ],
};

const L = (lang: NavLang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const marketing = (lang: NavLang) => `${BRAND_MARKETING_URL}${lang === 'ar' ? '/' : '/en/'}`;

/** The five site links, in the one order every support site shows them. */
export function siteNavItems(lang: NavLang): SiteNavItem[] {
  const d = BRAND.domains;
  return [
    {
      id: 'studio',
      href: marketing(lang),
      label: lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn,
    },
    { id: 'dashboard', href: BRAND_STORE_APP_URL, label: L(lang, 'لوحة التحكم', 'Dashboard') },
    // docs: English at the root, Arabic under /ar/. help and status: Arabic at the root, English under /en.
    {
      id: 'docs',
      href: `https://${d.docs}/${lang === 'ar' ? 'ar/' : ''}`,
      label: L(lang, 'الوثائق', 'Docs'),
    },
    {
      id: 'help',
      href: `https://${d.help}/${lang === 'ar' ? '' : 'en/'}`,
      label: L(lang, 'مركز المساعدة', 'Help centre'),
    },
    {
      id: 'status',
      href: `https://${d.status}/${lang === 'ar' ? '' : 'en'}`,
      label: L(lang, 'حالة الخدمة', 'Status'),
    },
  ];
}

/**
 * The Products menu: only live products (BRAND-ARCH-1), Ebda Store then Ebda WhatsApp (LAUNCH-SUITE-1). The same entries,
 * labels and blurbs as the marketing header's Products panel (tests/unit/site-nav-shared.test.ts keeps them equal).
 */
export function siteNavProducts(lang: NavLang): SiteNavProduct[] {
  return [
    {
      id: 'store',
      href: marketing(lang),
      label: lang === 'ar' ? BRAND.product.nameAr : BRAND.product.nameEn,
      blurb: L(lang, 'متجرك أونلاين في دقايق', 'Your online store in minutes'),
    },
    {
      id: 'whatsapp',
      href: `${marketing(lang)}whatsapp/`,
      label: lang === 'ar' ? BRAND.productWhatsapp.nameAr : BRAND.productWhatsapp.nameEn,
      blurb: L(
        lang,
        'كلّم عملاءك على واتساب من مكان واحد',
        'Talk to your customers on WhatsApp, from one inbox'
      ),
    },
  ];
}

export const siteNavLabels = (lang: NavLang) => ({
  nav: L(lang, 'التنقل الرئيسي', 'Main navigation'),
  products: L(lang, 'المنتجات', 'Products'),
  menu: L(lang, 'القائمة', 'Menu'),
});

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

/** The studio lockup: mark + the master brand name + the site name. `markHtml` is the caller's icon (an <img> or inline SVG). */
export function siteWordmarkHtml(p: {
  lang: NavLang;
  href: string;
  siteLabel: string;
  markHtml: string;
}): string {
  const studio = p.lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn;
  return `<a class="wordmark" href="${esc(p.href)}">${p.markHtml}<span>${esc(studio)}</span><span class="wm-site">${esc(p.siteLabel)}</span></a>`;
}

/** The icon as an inline <svg> string (decorative). */
export function siteNavIconSvg(id: SiteNavProductId): string {
  const paths = SITE_NAV_ICONS[id]
    .map(p =>
      p.fill
        ? `<path d="${p.d}" fill="currentColor"/>`
        : `<path d="${p.d}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>`
    )
    .join('');
  return `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** The header nav: desktop link row with the Products disclosure, and the mobile menu (below 1180px it collapses into the menu button; wider, it is its own row under the wordmark, search and language switch). */
export function siteNavHtml(lang: NavLang, active: NavSite | null): string {
  const t = siteNavLabels(lang);
  const items = siteNavItems(lang);
  const products = siteNavProducts(lang);
  const link = (i: SiteNavItem) =>
    `<li><a href="${esc(i.href)}"${i.id === active ? ' aria-current="page"' : ''}>${esc(i.label)}</a></li>`;
  // one card per product: icon tile, full name, one-sentence blurb (the marketing header renders the same pieces in React)
  const prod = (p: SiteNavProduct) =>
    `<li><a href="${esc(p.href)}"><span class="np-ico">${siteNavIconSvg(p.id)}</span><span class="np-txt"><b>${esc(p.label)}</b><span>${esc(p.blurb)}</span></span></a></li>`;
  return (
    `<nav class="top-nav" aria-label="${esc(t.nav)}">` +
    `<ul class="nav-links"><li class="nav-products"><details><summary>${esc(t.products)}</summary><ul>${products.map(prod).join('')}</ul></details></li>${items.map(link).join('')}</ul>` +
    `<details class="nav-menu"><summary><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg><span>${esc(t.menu)}</span></summary>` +
    `<ul><li class="menu-group"><p>${esc(t.products)}</p><ul>${products.map(p => `<li><a href="${esc(p.href)}">${esc(p.label)}</a></li>`).join('')}</ul></li>${items.map(link).join('')}</ul></details>` +
    `</nav>`
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
.top-nav a{color:var(--fg);text-decoration:none;padding:6px 2px;display:inline-block}
.top-nav a:hover{color:var(--lift)}
.top-nav a[aria-current=page]{color:var(--lift);border-bottom:2px solid var(--lift)}
.top-nav summary{cursor:pointer;list-style:none;color:var(--fg);padding:6px 2px;display:inline-flex;align-items:center;gap:6px;min-height:44px}
.top-nav summary::-webkit-details-marker{display:none}
.nav-products>details>summary::after{content:"";width:6px;height:6px;border:solid currentColor;border-width:0 1.5px 1.5px 0;transform:rotate(45deg);margin-block-start:-3px}
.nav-menu>ul{position:absolute;z-index:60;min-width:230px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px;margin-block-start:6px}
.nav-menu{display:none}
.nav-menu>ul a{display:block;padding:10px;min-height:44px}
@media (max-width:1179px){.top-nav{order:0;flex:0 0 auto;margin-inline-start:auto}.top-nav .nav-links{display:none}.nav-menu{display:block}}
`.replace(/\n/g, '') + SITE_NAV_PANEL_CSS;
