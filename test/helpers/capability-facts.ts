/**
 * Code facts for the capability guards (foundation `CodeFacts`) from Ebda Chat's own code: the Hono route table under /api/v1 and the
 * web rail views. Pure (inputs in, facts out) so it runs in the workers project with no file access.
 *
 * Pages: the web app has hash views, not file routes. Each member of `export type View` in web/src/components/Rail.tsx is the page
 * `/<view>` (the registry claims it with a `screens` entry such as `/inbox`; foundation coverage only compares `/` paths).
 */
import type { GuardConfig } from '../../foundation/capability';
import type { CodeFacts } from '../../foundation/capability-coverage';

export interface HonoRoute {
  method: string;
  path: string;
}
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** `export type View = 'inbox' | 'campaigns' ...` -> ['inbox', 'campaigns', ...] */
export function railViews(railSource: string): string[] {
  const m = /export type View\s*=\s*([^;]+);/.exec(railSource);
  return m ? [...m[1]!.matchAll(/'([a-z][\w-]*)'/g)].map((x) => x[1]!) : [];
}

export function chatCodeFacts(cfg: GuardConfig, routes: readonly HonoRoute[], railSource: string): CodeFacts {
  const seen = new Set<string>();
  const out: CodeFacts['routes'] = [];
  for (const r of routes) {
    const path = r.path.startsWith('/api/v1/') ? r.path.slice('/api/v1'.length) : r.path;
    if (path.includes('*')) continue; // `use` middleware registers as ALL on a wildcard path: not a handler
    const method = r.method.toUpperCase();
    if (method === 'HEAD' || method === 'OPTIONS') continue;
    const kind = cfg.routeKinds.find((k) => new RegExp(k.match).test(path))?.kind ?? 'merchant';
    for (const m of method === 'ALL' ? VERBS : [method]) {
      const key = `${m} ${path}`;
      if (seen.has(key)) continue; // a route with middleware appears once per handler
      seen.add(key);
      out.push({ method: m, path, kind });
    }
  }
  return { pages: railViews(railSource).map((v) => `/${v}`), routes: out };
}
