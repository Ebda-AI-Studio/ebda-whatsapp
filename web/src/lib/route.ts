import { useCallback, useEffect, useState } from 'react';
import type { View } from '../components/Rail';

// One address per screen (History API, no router dependency). The Worker serves the shell for exactly these paths (src/index.ts SHELL_PATHS),
// so a refresh or a shared link lands on the same screen. Keep both lists in step: test/shell-routes.test.ts compares them.
export const VIEW_PATHS: Record<View, string> = {
  inbox: '/', campaigns: '/campaigns', templates: '/templates', contacts: '/contacts', agent: '/agent', bot: '/bot', numbers: '/numbers', integrations: '/integrations', wallet: '/wallet', team: '/team', operator: '/ops',
};
export const CHAT_PREFIX = '/chat/';

export type Route = { kind: 'view'; view: View; chatId: number | null } | { kind: 'notfound' };

export function parsePath(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (p === '/auth/callback') return { kind: 'view', view: 'inbox', chatId: null }; // the sign-in return is replaced by the page it came from; until then it is the inbox
  const hit = (Object.entries(VIEW_PATHS) as [View, string][]).find(([, path]) => path === p);
  if (hit) return { kind: 'view', view: hit[0], chatId: null };
  if (p.startsWith(CHAT_PREFIX)) {
    const id = p.slice(CHAT_PREFIX.length);
    if (/^[1-9]\d{0,15}$/.test(id)) return { kind: 'view', view: 'inbox', chatId: Number(id) };
  }
  return { kind: 'notfound' };
}

/**
 * Before real paths, each screen lived at `/#<screen>` (`#wallet`, `#numbers`, ...). Those links are still out there (emails, notifications, help articles,
 * bookmarks), so a hash that names a screen is mapped to its path. `#operator` was the old key of `/ops`; `#/wallet` (a path in the hash) is accepted too.
 * Returns null for anything else (an in-page anchor like `#w-credits` is none of our business).
 */
export function legacyHashPath(hash: string): string | null {
  const key = hash.replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  if (key === 'operator') return VIEW_PATHS.operator;
  const hit = (Object.entries(VIEW_PATHS) as [View, string][]).find(([view]) => view === key);
  return hit ? hit[1] : null;
}

/** Runs once at boot, before the first route is read: `/#contacts` becomes `/contacts` and `/inbox` becomes `/` (history.replaceState, so Back does not bounce). The query string is kept. */
export function normaliseLocation(): void {
  const path = location.pathname.length > 1 ? location.pathname.replace(/\/+$/, '') : location.pathname;
  const target = path === '/inbox' ? '/' : (path === '/' ? legacyHashPath(location.hash) : null);
  if (target !== null && (target !== location.pathname || location.hash)) history.replaceState(null, '', target + location.search);
}

export const pathFor = (view: View, chatId: number | null = null): string => (view === 'inbox' && chatId !== null ? `${CHAT_PREFIX}${chatId}` : VIEW_PATHS[view]);

/** The current route, kept in step with the address bar. `go` pushes a history entry (back/forward work); a popstate re-reads the address. */
export function useRoute(): { route: Route; go: (view: View, chatId?: number | null) => void } {
  const [route, setRoute] = useState<Route>(() => { normaliseLocation(); return parsePath(location.pathname); });
  useEffect(() => {
    const onPop = () => { normaliseLocation(); setRoute(parsePath(location.pathname)); }; // popstate also fires for a hand-edited hash on `/`
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop); // a legacy `#wallet` link clicked while the app is open
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
  }, []);
  const go = useCallback((view: View, chatId: number | null = null) => {
    const next = pathFor(view, chatId);
    if (location.pathname !== next) history.pushState(null, '', next + location.search); // keep ?store= / ?viewAs= so the same workspace stays open
    setRoute({ kind: 'view', view, chatId });
  }, []);
  return { route, go };
}
