import { pickStudioLang, renderStudioPage, STUDIO_PAGE_HEADERS } from '../../../vendor/studio/studio-pages/index';

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
  return new Response(req.method === 'HEAD' ? null : renderStudioPage({ lang, kind: 'not-found' }), { status: 404, headers: STUDIO_PAGE_HEADERS });
}
