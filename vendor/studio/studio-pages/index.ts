/**
 * Ebda AI Studio's own "this address has nothing for you" pages: the Apple-style 404 and the
 * "coming soon" page for reserved product hosts (crm, erp, hub, id, wa). ONE pure renderer, no runtime
 * imports, so the store Worker's middleware, the marketing build and the status Worker share it.
 *
 * Calm on purpose: one sentence, a search box (a plain GET form to the help search, so it works with no
 * script), and a compact map of what is live. Night + gold, no orange. Arabic is Egyptian full sentences.
 * Never lists or suggests a store (privacy). 404 pages are noindex; so is coming-soon.
 */
import { BRAND, brandMarkSvg } from '../brand';

export type StudioLang = 'ar' | 'en';
export type StudioPageKind = 'not-found' | 'coming-soon';
/** Which upcoming product a coming-soon page names; `reserved` = an address held for a future service. */
export type ComingSoonProduct = 'whatsapp' | 'crm' | 'erp' | 'reserved';

export interface StudioPageInput {
  lang: StudioLang;
  kind: StudioPageKind;
  product?: ComingSoonProduct;
}

export interface StudioHostPlan {
  status: 200 | 404;
  kind: StudioPageKind;
  product?: ComingSoonProduct;
}

const COMING_SOON_LABELS: Readonly<Record<string, ComingSoonProduct>> = {
  wa: 'whatsapp',
  whatsapp: 'whatsapp',
  crm: 'crm',
  erp: 'erp',
  hub: 'reserved',
  id: 'reserved',
};

/**
 * What a bare label under `.ebda.app` (a reserved or malformed one that no Worker serves) should show:
 * the named upcoming products answer 200 "coming soon"; everything else is a real 404.
 */
export function studioHostPlan(label: string): StudioHostPlan {
  const product = COMING_SOON_LABELS[label.trim().toLowerCase()];
  return product
    ? { status: 200, kind: 'coming-soon', product }
    : { status: 404, kind: 'not-found' };
}

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
  soonLine: Record<ComingSoonProduct, string>;
  soonHint: string;
  contact: string;
  switchTo: string;
  groups: { live: string; support: string; next: string };
  links: { home: string; store: string; help: string; docs: string; status: string };
  products: { whatsapp: string; crm: string; erp: string };
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
    soonLine: {
      whatsapp: 'Ebda Chat is coming soon.',
      crm: 'Ebda CRM is coming soon.',
      erp: 'Ebda ERP is coming soon.',
      reserved: 'This address is held for an upcoming service from Ebda AI Studio.',
    },
    soonHint: "We're still building it. Here is what is live today.",
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
    products: { whatsapp: 'Ebda Chat', crm: 'Ebda CRM', erp: 'Ebda ERP' },
  },
  ar: {
    title404: 'الصفحة مش موجودة',
    line404: 'الصفحة اللي بتدوّر عليها مش موجودة.',
    hint: 'دوّر على اللي كنت تقصده، أو اختار قسم من تحت.',
    searchLabel: 'دوّر في الموقع',
    searchPlaceholder: 'دوّر في المساعدة والشروحات',
    searchButton: 'بحث',
    mapLabel: 'أقسام الموقع',
    soon: 'قريباً',
    soonLine: {
      whatsapp: 'ابدأ شات جاي قريب.',
      crm: 'ابدأ CRM جاي قريب.',
      erp: 'ابدأ ERP جاي قريب.',
      reserved: 'العنوان ده محجوز لخدمة جاية من ابدأ ستوديو للذكاء الاصطناعي.',
    },
    soonHint: 'لسه بنشتغل عليه. وده اللي شغال النهارده.',
    contact: 'تواصل معانا',
    switchTo: 'English',
    groups: { live: 'شغال النهارده', support: 'المساعدة', next: 'قريباً' },
    links: {
      home: 'ابدأ ستوديو للذكاء الاصطناعي',
      store: 'ابدأ ستور',
      help: 'مركز المساعدة',
      docs: 'وثائق المطوّرين',
      status: 'حالة الخدمة',
    },
    products: { whatsapp: 'ابدأ شات', crm: 'ابدأ CRM', erp: 'ابدأ ERP' },
  },
};

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
export function renderStudioPage(input: StudioPageInput): string {
  const { lang, kind } = input;
  const c = COPY[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const product = input.product ?? 'reserved';
  const soon = kind === 'coming-soon';
  const line = soon ? c.soonLine[product] : c.line404;
  const hint = soon ? c.soonHint : c.hint;
  const title = `${soon ? c.soonLine[product] : c.title404} | ${lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn}`;
  const help = `https://${BRAND.domains.help}`;
  const searchAction = lang === 'ar' ? `${help}/search/` : `${help}/en/search/`;
  const otherLang = lang === 'ar' ? 'en' : 'ar';
  const li = (href: string, label: string) => `<li><a href="${esc(href)}">${esc(label)}</a></li>`;
  const next = (key: 'whatsapp' | 'crm' | 'erp') =>
    `<li class="soon"${soon && product === key ? ' aria-current="page"' : ''}>${esc(c.products[key])}<b>${esc(c.soon)}</b></li>`;
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
<h1>${esc(line)}</h1>
<p class="hint">${esc(hint)}</p>
<form class="search" role="search" action="${esc(searchAction)}" method="get" data-sources="${esc(JSON.stringify(SOURCES(lang)))}">
<label class="sr-only" for="q">${esc(c.searchLabel)}</label>
<input id="q" name="q" type="search" placeholder="${esc(c.searchPlaceholder)}" autocomplete="off" enterkeyhint="search">
<button type="submit">${esc(c.searchButton)}</button>
</form>
<nav class="map" aria-label="${esc(c.mapLabel)}">
<div><h2>${esc(c.groups.live)}</h2><ul>
${li(`https://${BRAND.domains.marketing}/`, c.links.home)}
${li(`https://${BRAND.domains.storeApp}/`, c.links.store)}
${li(`https://${BRAND.domains.status}/`, c.links.status)}
</ul></div>
<div><h2>${esc(c.groups.support)}</h2><ul>
${li(help + (lang === 'ar' ? '/' : '/en/'), c.links.help)}
${li(`https://${BRAND.domains.docs}/`, c.links.docs)}
${li(`mailto:${BRAND.supportEmail}`, c.contact)}
${li(wa, 'WhatsApp')}
</ul></div>
<div><h2>${esc(c.groups.next)}</h2><ul>
${next('whatsapp')}
${next('crm')}
${next('erp')}
</ul></div>
</nav>
</main>
<footer>
<span>© ${new Date().getUTCFullYear()} ${esc(lang === 'ar' ? BRAND.company.shortNameAr : BRAND.company.shortNameEn)}</span>
<a href="?lang=${otherLang}" hreflang="${otherLang}" lang="${otherLang}">${esc(c.switchTo)}</a>
</footer>
<script src="https://${BRAND.domains.help}/assets/typeahead.js" defer></script>
</body>
</html>
`;
}

/**
 * Response headers for a studio page: not cacheable (nothing may misfile it under another host), noindex,
 * and a locked-down CSP whose only allowances are the help typeahead script and the help/docs indexes.
 */
/** The one HSTS policy every Ebda host sends (api, store, orders, studio pages, accounts, status). */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains; preload';

export const STUDIO_PAGE_HEADERS: Readonly<Record<string, string>> = {
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
