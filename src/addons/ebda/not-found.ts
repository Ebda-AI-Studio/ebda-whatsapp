import { BRAND, brandMarkSvg } from '../../../vendor/studio/brand/index';
import { createStudioPages, pickStudioLang, type StudioBrand } from '../../../foundation/studio-pages';

/**
 * The studio shell (F8) is the foundation's `createStudioPages`; Chat only supplies its brand data. The vendored BRAND (a Store snapshot) has no
 * coming-soon list, and the shell's "what is coming" column names CRM and ERP only (Ahmad's public-copy rule 2026-11-11), the same two rows as the
 * Store's `BRAND.comingProducts`: kept here until the vendored brand is re-vendored with it.
 */
const COMING_PRODUCTS: StudioBrand['comingProducts'] = [
  { id: 'crm', nameAr: 'ابدأ CRM', nameEn: 'Ebda CRM', shortAr: 'عملاؤك ومتابعاتهم في مكان واحد', shortEn: 'Your customers and follow-ups in one place' },
  { id: 'erp', nameAr: 'ابدأ ERP', nameEn: 'Ebda ERP', shortAr: 'المخزون والمشتريات والحسابات والفروع', shortEn: 'Inventory, purchasing, accounts and branches' },
];
const { renderStudioPage, STUDIO_PAGE_HEADERS } = createStudioPages({ ...BRAND, comingProducts: COMING_PRODUCTS }, brandMarkSvg);

/** The edge adds the visit-count script (beacon.min.js on this host) to every HTML page on the zone, this one included. */
const VISIT_COUNT_SCRIPT_HOST = 'https://static.cloudflareinsights.com';

/**
 * The vendored headers with exactly one change: `script-src` also names the visit-count host, or the browser refuses the script the
 * edge adds (a console error, and the 404 visit is never counted). Done here, not in vendor/, because the shell is the foundation's file
 * byte for byte (lock-pinned); the Store's copy needs the same host, and once it has it a re-vendor makes this a no-op.
 */
export const NOT_FOUND_HEADERS: Readonly<Record<string, string>> = {
  ...STUDIO_PAGE_HEADERS,
  'Content-Security-Policy': STUDIO_PAGE_HEADERS['Content-Security-Policy']!.split('; ')
    .map((d) => (d.startsWith('script-src ') && !d.split(' ').includes(VISIT_COUNT_SCRIPT_HOST) ? `${d} ${VISIT_COUNT_SCRIPT_HOST}` : d))
    .join('; '),
};

/**
 * Ruling WA-404-1: an address this app does not serve answers 404 with Ebda AI Studio's shared "nothing here" page (the renderer the
 * Store hosts use, now vendored from ebda-foundation: foundation/studio-pages.ts, F8). A read of an unknown path gets the page; any other
 * method gets the JSON 404 the API speaks, so a client never receives HTML it did not ask for.
 */
export function ebdaNotFound(req: Request): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return null;
  const lang = pickStudioLang(req.headers.get('accept-language'), url.searchParams.get('lang'));
  return new Response(req.method === 'HEAD' ? null : renderStudioPage({ lang, kind: 'not-found' }), { status: 404, headers: NOT_FOUND_HEADERS });
}
