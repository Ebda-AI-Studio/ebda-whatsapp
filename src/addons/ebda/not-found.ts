import { pickStudioLang, renderStudioPage, STUDIO_PAGE_HEADERS } from '../../../vendor/studio/studio-pages/index';

/** The edge adds the visit-count script (beacon.min.js on this host) to every HTML page on the zone, this one included. */
const VISIT_COUNT_SCRIPT_HOST = 'https://static.cloudflareinsights.com';

/**
 * The vendored headers with exactly one change: `script-src` also names the visit-count host, or the browser refuses the script the
 * edge adds (a console error, and the 404 visit is never counted). Done here, not in vendor/, because vendor/studio is the Store's file
 * byte for byte (sha-pinned); the Store's copy needs the same host, and once it has it a re-vendor makes this a no-op.
 */
export const NOT_FOUND_HEADERS: Readonly<Record<string, string>> = {
  ...STUDIO_PAGE_HEADERS,
  'Content-Security-Policy': STUDIO_PAGE_HEADERS['Content-Security-Policy']!.split('; ')
    .map((d) => (d.startsWith('script-src ') && !d.split(' ').includes(VISIT_COUNT_SCRIPT_HOST) ? `${d} ${VISIT_COUNT_SCRIPT_HOST}` : d))
    .join('; '),
};

/**
 * Ruling WA-404-1: an address this app does not serve answers 404 with Ebda AI Studio's shared "nothing here" page (the renderer the
 * Store hosts use, vendored byte for byte under vendor/studio and sha-pinned). A read of an unknown path gets the page; any other
 * method gets the JSON 404 the API speaks, so a client never receives HTML it did not ask for.
 */
export function ebdaNotFound(req: Request): Response | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return null;
  const lang = pickStudioLang(req.headers.get('accept-language'), url.searchParams.get('lang'));
  return new Response(req.method === 'HEAD' ? null : renderStudioPage({ lang, kind: 'not-found' }), { status: 404, headers: NOT_FOUND_HEADERS });
}
