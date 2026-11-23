/**
 * Ebda AI Studio's own "this address has nothing for you" pages: the Apple-style 404 and the
 * "coming soon" page for every coming-soon software product (crm, erp: ONE template, only the copy
 * differs, Ruling SUBDOMAIN-SOON-2) and the "reserved" page (hub, id). ONE pure renderer, no runtime
 * imports, so the store Worker's middleware, the marketing build and the status Worker share it.
 *
 * Calm on purpose: one sentence, a search box (a plain GET form to the help search, so it works with no
 * script), and a compact map of what is live. Night + gold, no orange. Arabic is Egyptian full sentences.
 * Never lists or suggests a store (privacy). 404 pages are noindex; so is coming-soon.
 *
 * FOUNDATION (F8): the renderer is a factory over the product's brand data, because the full BRAND object (domains, colours, coming-soon
 * products, support email, contact line, brand mark) lives in each product (the Store's `BRAND`). A product calls
 * `createStudioPages(BRAND, brandMarkSvg)` once and re-exports the result; its output is byte-identical to the renderer it replaced.
 */

export type StudioLang = 'ar' | 'en';
export type StudioPageKind = 'not-found' | 'coming-soon';

/** The part of a product's BRAND the studio pages read. The Store's BRAND satisfies it structurally. */
export interface StudioBrand {
  readonly colors: { readonly night: string; readonly gold: string; readonly lift: string };
  readonly domains: {
    readonly marketing: string;
    readonly storeApp: string;
    readonly whatsappApp: string;
    readonly status: string;
    readonly docs: string;
    readonly help: string;
  };
  readonly company: { readonly shortNameAr: string; readonly shortNameEn: string };
  readonly supportEmail: string;
  readonly contact: { readonly whatsapp: string };
  /** The coming-soon software products (id = the label's product); the single source of their names and one-line descriptions. */
  readonly comingProducts: readonly {
    readonly id: string;
    readonly nameAr: string;
    readonly nameEn: string;
    readonly shortAr: string;
    readonly shortEn: string;
  }[];
}

export interface StudioPageInput {
  lang: StudioLang;
  kind: StudioPageKind;
  /** A coming-soon product id from the brand, or `reserved` (an address held for a future service). */
  product?: string;
}

export type StudioHostPlan =
  | { status: 200 | 404; kind: StudioPageKind; product?: string }
  /** a label that names a LIVE product on another host: a permanent redirect there (path and query kept) */
  | { status: 301; kind: 'redirect'; host: string };

const COMING_SOON_LABELS: Readonly<Record<string, string>> = {
  // every coming-soon software product gets its own page (Ruling SUBDOMAIN-SOON-2); names = BRAND.comingProducts
  crm: 'crm',
  erp: 'erp',
  // held addresses with no announced product: the neutral reserved page, never "coming soon" (public-copy rule 2026-11-11)
  invite: 'reserved',
  ads: 'reserved',
  quote: 'reserved',
  'quote-studio': 'reserved',
  hub: 'reserved',
  id: 'reserved',
};

/** The one HSTS policy every Ebda host sends (api, store, orders, studio pages, accounts, status). */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';

/** `?lang=` wins, then the first Accept-Language entry; Arabic is the default (Egypt-first). */
export function pickStudioLang(
  acceptLanguage: string | null | undefined,
  queryLang?: string | null
): StudioLang {
  if (queryLang === 'en' || queryLang === 'ar') return queryLang;
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'ar';
}

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

interface Copy {
  title404: string;
  line404: string;
  hint: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchButton: string;
  mapLabel: string;
  soon: string;
  /** the page heading's sentence for a coming-soon product, built from its BRAND name */
  soonLine: (name: string) => string;
  reservedLine: string;
  soonHint: string;
  notify: string;
  backHome: string;
  contact: string;
  switchTo: string;
  groups: { live: string; support: string; next: string };
  links: { home: string; store: string; help: string; docs: string; status: string };
  chat: string;
}

const COPY: Record<StudioLang, Copy> = {
  en: {
    title404: 'Page not found',
    line404: "The page you're looking for can't be found.",
    hint: 'Search for what you meant, or pick a section below.',
    searchLabel: 'Search the site',
    searchPlaceholder: 'Search help and guides',
    searchButton: 'Search',
    mapLabel: 'Site sections',
    soon: 'Coming soon',
    soonLine: name => `${name} is coming soon.`,
    reservedLine: 'This address is reserved by Ebda AI Studio.',
    soonHint: "We're still building it. Here is what is live today.",
    notify: 'Tell me when it is ready',
    backHome: 'Back to ebda.app',
    contact: 'Contact',
    switchTo: 'العربية',
    groups: { live: 'Live today', support: 'Help', next: 'Coming soon' },
    links: {
      home: 'Ebda AI Studio',
      store: 'Ebda Store',
      help: 'Help center',
      docs: 'Developer docs',
      status: 'Service status',
    },
    chat: 'Ebda Chat',
  },
  ar: {
    title404: 'الصفحة مش موجودة',
    line404: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده، أو اختار قسم من تحت.',
    searchLabel: 'دوّر في الموقع',
    searchPlaceholder: 'دوّر في المساعدة والشروحات',
    searchButton: 'بحث',
    mapLabel: 'أقسام الموقع',
    soon: 'قريبًا',
    soonLine: name => `${name} جاي قريب.`,
    reservedLine: 'العنوان ده محجوز لابدأ ستوديو للذكاء الاصطناعي.',
    soonHint: 'لسه بنشتغل عليه. وده اللي شغال النهارده.',
    notify: 'عرّفني أول ما يجهز',
    backHome: 'ارجع لـ ebda.app',
    contact: 'تواصل معانا',
    switchTo: 'English',
    groups: { live: 'شغال النهارده', support: 'المساعدة', next: 'قريبًا' },
    links: {
      home: 'ابدأ ستوديو للذكاء الاصطناعي',
      store: 'ابدأ ستور',
      help: 'مركز المساعدة',
      docs: 'وثائق المطوّرين',
      status: 'حالة الخدمة',
    },
    chat: 'ابدأ شات',
  },
};


export interface StudioPages {
  studioHostPlan: (label: string) => StudioHostPlan;
  renderStudioPage: (input: StudioPageInput) => string;
  STUDIO_PAGE_HEADERS: Readonly<Record<string, string>>;
  STUDIO_COMING_SOON_LABELS: readonly string[];
  STUDIO_REDIRECT_LABELS: readonly string[];
}

/** Bind the studio pages to one product's brand data. */
export function createStudioPages(
  BRAND: StudioBrand,
  brandMarkSvg: (opts: { size?: number; cls?: string }) => string
): StudioPages {
// NOTE: this body is deliberately NOT re-indented. It was moved from the Store verbatim and holds multi-line template literals (the CSS and the
// HTML document); indenting them would change the served bytes. The Store's golden-hash test proves the output is unchanged.
/**
 * Labels that name a product which is LIVE on another host (Ruling WHATSAPP-HOST-REDIRECT-1): Ebda Chat is live at
 * wa.ebda.app (its own Worker), so whatsapp.ebda.app must never say it is "coming soon"; it redirects there.
 * `wa` itself is not listed anywhere here: its Worker's route serves it, and if that route ever vanished a 404
 * is honest while a redirect to itself would loop.
 */
const REDIRECT_LABELS: Readonly<Record<string, string>> = {
  whatsapp: BRAND.domains.whatsappApp,
  chat: BRAND.domains.whatsappApp,
};

/** Every label that answers a coming-soon page (for tests and the reserved-slug parity check). */
const STUDIO_COMING_SOON_LABELS: readonly string[] = Object.keys(COMING_SOON_LABELS);
/** Every label that redirects to a live product elsewhere. */
const STUDIO_REDIRECT_LABELS: readonly string[] = Object.keys(REDIRECT_LABELS);

/**
 * What a bare label under `.ebda.app` (a reserved or malformed one that no Worker serves) should show:
 * a live product's other name redirects to it; the named upcoming products answer 200 "coming soon";
 * everything else is a real 404.
 */
function studioHostPlan(label: string): StudioHostPlan {
  const key = label.trim().toLowerCase();
  const host = REDIRECT_LABELS[key];
  if (host) return { status: 301, kind: 'redirect', host };
  const product = COMING_SOON_LABELS[key];
  return product
    ? { status: 200, kind: 'coming-soon', product }
    : { status: 404, kind: 'not-found' };
}

const CSS = `
:root{color-scheme:dark;--night:${BRAND.colors.night};--gold:${BRAND.colors.gold};--lift:${BRAND.colors.lift};--fg:#f3f1ec;--muted:#a9a49b;--line:#2b2d2f;--panel:#121415}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-block-size:100dvh;background:var(--night);color:var(--fg);font:400 1rem/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI","IBM Plex Sans Arabic","Noto Sans Arabic",Tahoma,sans-serif;display:flex;flex-direction:column}
::selection{background:var(--gold);color:var(--night)}
a{color:var(--lift);text-underline-offset:.22em;text-decoration-thickness:1px}
a:hover{color:#fff}
:focus-visible{outline:2px solid var(--lift);outline-offset:3px;border-radius:6px}
.skip{position:absolute;inset-inline-start:-999px}
.skip:focus{inset-inline-start:16px;top:12px;background:var(--panel);padding:8px 12px;border-radius:8px;z-index:2}
.sr-only{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
header,footer{padding:20px clamp(16px,5vw,48px);display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);text-decoration:none;font-weight:600}
main{flex:1;inline-size:min(100%,760px);margin-inline:auto;padding:clamp(40px,12vh,120px) clamp(16px,5vw,32px) 48px}
h1{margin:0 0 12px;font-size:clamp(1.75rem,5vw,2.75rem);line-height:1.2;font-weight:600;letter-spacing:-.02em;text-wrap:balance}
.hint{margin:0 0 32px;color:var(--muted);max-inline-size:60ch}
form.search{display:flex;gap:10px;margin:0 0 56px}
form.search input{flex:1;min-inline-size:0;block-size:52px;padding-inline:18px;background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:14px;font:inherit;font-size:1rem}
form.search input::placeholder{color:#8a857d}
form.search input:focus{border-color:var(--gold);outline:2px solid var(--gold);outline-offset:0}
form.search button{block-size:52px;padding-inline:22px;background:var(--gold);color:var(--night);border:0;border-radius:14px;font:inherit;font-weight:600;cursor:pointer}
form.search button:hover{background:var(--lift)}
nav.map{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:32px 40px}
nav.map h2{margin:0 0 10px;font-size:.8125rem;font-weight:600;color:var(--muted);letter-spacing:.02em}
nav.map ul{margin:0;padding:0;list-style:none;display:grid;gap:8px}
nav.map li{min-block-size:28px}
.soon{color:var(--muted)}
.soon b{margin-inline-start:8px;font-weight:500;font-size:.8125rem;color:var(--gold)}
.lead{margin:0 0 16px;font-size:1.125rem;color:var(--fg);max-inline-size:60ch}
.badge{display:inline-block;margin:0 0 28px;padding:2px 12px;border:1px solid var(--gold);border-radius:999px;color:var(--lift);font-size:.8125rem;font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 56px}
.actions a{display:inline-flex;align-items:center;min-block-size:48px;padding-inline:22px;border-radius:14px;font-weight:600;text-decoration:none}
.actions .cta{background:var(--gold);color:var(--night)}
.actions .cta:hover{background:var(--lift);color:var(--night)}
.actions .home{border:1px solid var(--line);color:var(--fg)}
.actions .home:hover{border-color:var(--gold)}
[aria-current=page]{color:var(--fg);font-weight:600}
footer{color:var(--muted);font-size:.875rem;border-top:1px solid var(--line)}
form.search{position:relative}
.ta-list,.ta-note{position:absolute;inset-inline:0;top:calc(100% + 8px);z-index:5;margin:0;padding:6px;list-style:none;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 40px rgba(0,0,0,.5);text-align:start}
.ta-note{padding:14px 16px;color:var(--muted)}
.ta-list[hidden],.ta-note[hidden]{display:none}
.ta-list a{display:flex;flex-direction:column;gap:2px;min-block-size:44px;justify-content:center;padding:8px 12px;border-radius:8px;color:var(--fg);text-decoration:none}
.ta-list a[aria-selected=true],.ta-list a:hover{background:#1b1e20;outline:1px solid var(--gold)}
.ta-list mark{background:transparent;color:var(--lift);font-weight:700}
.ta-sec{color:var(--muted);font-size:.8125rem}
.ta-all{color:var(--muted)!important;font-size:.9rem}
@media (max-width:520px){form.search{flex-direction:column}form.search input{flex:none;inline-size:100%}form.search button{inline-size:100%}}
`;

/** The indexes the live search reads: help (in the page language) and the developer docs, both cross-origin. */
const SOURCES = (lang: StudioLang) => [
  {
    index: `https://${BRAND.domains.help}/search-index.${lang}.json`,
    base: `https://${BRAND.domains.help}`,
  },
  {
    index: `https://${BRAND.domains.docs}/search-index.en.json`,
    base: `https://${BRAND.domains.docs}`,
  },
];

/** The page, as a complete HTML document string. */
function renderStudioPage(input: StudioPageInput): string {
  const { lang, kind } = input;
  const c = COPY[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const product = input.product ?? 'reserved';
  const soon = kind === 'coming-soon';
  const brandProduct =
    soon && product !== 'reserved' ? BRAND.comingProducts.find(p => p.id === product) : undefined;
  const name = brandProduct ? (lang === 'ar' ? brandProduct.nameAr : brandProduct.nameEn) : '';
  const short = brandProduct ? (lang === 'ar' ? brandProduct.shortAr : brandProduct.shortEn) : '';
  const line = soon ? (brandProduct ? c.soonLine(name) : c.reservedLine) : c.line404;
  const hint = soon ? c.soonHint : c.hint;
  const title = `${line === c.line404 ? c.title404 : line} | ${lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn}`;
  const home = `https://${BRAND.domains.marketing}${lang === 'ar' ? '/' : '/en/'}`;
  const notifyHref = `${home}contact/?topic=products#form`;
  const help = `https://${BRAND.domains.help}`;
  const searchAction = lang === 'ar' ? `${help}/search/` : `${help}/en/search/`;
  const otherLang = lang === 'ar' ? 'en' : 'ar';
  const li = (href: string, label: string) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`;
  const next = (p: StudioBrand['comingProducts'][number]) =>
    `<li class="soon"${soon && product === p.id ? ' aria-current="page"' : ''}>${esc(lang === 'ar' ? p.nameAr : p.nameEn)}<b>${esc(c.soon)}</b></li>`;
  // ONE template for every coming-soon product (SUBDOMAIN-SOON-2): name, one line, the label, notify-me CTA, back to ebda.app.
  // Only the copy differs between products; the 404 and the reserved page keep the search box.
  const intro = brandProduct
    ? `<h1>${esc(name)}</h1>
<p class="lead">${esc(short)}</p>
<p class="badge">${esc(c.soon)}</p>
<p class="actions"><a class="cta" href="${esc(notifyHref)}">${esc(c.notify)}<span class="sr-only"> — ${esc(name)}</span></a><a class="home" href="${esc(home)}">${esc(c.backHome)}</a></p>`
    : `<h1>${esc(line)}</h1>
<p class="hint">${esc(hint)}</p>
<form class="search" role="search" action="${esc(searchAction)}" method="get" data-sources="${esc(JSON.stringify(SOURCES(lang)))}">
<label class="sr-only" for="q">${esc(c.searchLabel)}</label>
<input id="q" name="q" type="search" placeholder="${esc(c.searchPlaceholder)}" autocomplete="off" enterkeyhint="search">
<button type="submit">${esc(c.searchButton)}</button>
</form>`;
  const wa = `https://wa.me/${BRAND.contact.whatsapp.replace(/\D/g, '')}`;

  return `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="${BRAND.colors.night}">
<link rel="icon" href="https://${BRAND.domains.marketing}/icon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">${lang === 'ar' ? 'تخطَّ إلى المحتوى' : 'Skip to content'}</a>
<header>
<a class="brand" href="https://${BRAND.domains.marketing}/">${brandMarkSvg({ size: 28 })}<span>${esc(lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn)}</span></a>
</header>
<main id="main">
${intro}
<nav class="map" aria-label="${esc(c.mapLabel)}">
<div><h2>${esc(c.groups.live)}</h2><ul>
${li(`https://${BRAND.domains.marketing}/`, c.links.home)}
${li(`https://${BRAND.domains.storeApp}/`, c.links.store)}
${li(`https://${BRAND.domains.whatsappApp}/`, c.chat)}
${li(`https://${BRAND.domains.status}/`, c.links.status)}
</ul></div>
<div><h2>${esc(c.groups.support)}</h2><ul>
${li(help + (lang === 'ar' ? '/' : '/en/'), c.links.help)}
${li(`https://${BRAND.domains.docs}/`, c.links.docs)}
${li(`mailto:${BRAND.supportEmail}`, c.contact)}
${li(wa, 'WhatsApp')}
</ul></div>
<div><h2>${esc(c.groups.next)}</h2><ul>
${BRAND.comingProducts.map(next).join('\n')}
</ul></div>
</nav>
</main>
<footer>
<span>© ${new Date().getUTCFullYear()} ${esc(lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn)}</span>
<a href="?lang=${otherLang}" hreflang="${otherLang}" lang="${otherLang}">${esc(c.switchTo)}</a>
</footer>
${brandProduct ? '' : `<script src="https://${BRAND.domains.help}/assets/typeahead.js" defer></script>`}
</body>
</html>
`;
}

/**
 * Response headers for a studio page: not cacheable (nothing may misfile it under another host), noindex,
 * and a locked-down CSP whose only allowances are the help typeahead script and the help/docs indexes.
 */
const STUDIO_PAGE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  Vary: 'Accept-Language',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': HSTS_VALUE,
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src https://${BRAND.domains.help}`,
    "style-src 'unsafe-inline'",
    `connect-src https://${BRAND.domains.help} https://${BRAND.domains.docs}`,
    `img-src https://${BRAND.domains.marketing} data:`,
    `form-action https://${BRAND.domains.help}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

  return { studioHostPlan, renderStudioPage, STUDIO_PAGE_HEADERS, STUDIO_COMING_SOON_LABELS, STUDIO_REDIRECT_LABELS };
}
