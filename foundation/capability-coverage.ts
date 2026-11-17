import { normalizeApi, type Capability, type Violation } from './capability';

export interface CodeFacts {
  pages: string[];
  routes: { method: string; path: string; kind: 'merchant' | 'public' | 'internal' | 'super_admin' | 'operator' }[];
  mcpTools?: string[];
  planGates?: string[];
}

const fold = (p: string): string => {
  const t = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  return t.split('/').map((s) => (/^\[.+\]$/.test(s) || s.startsWith(':') ? ':_' : s)).join('/');
};

/** `/x/*` matches /x and any sub-path; otherwise exact. Dynamic segments ([id], :id) compare equal. */
export function pageMatches(pattern: string, page: string): boolean {
  const pat = fold(pattern);
  const pg = fold(page);
  if (pat.endsWith('/*')) {
    const base = pat.slice(0, -2);
    if (base === '') return false; // "/*" would cover every page; checkRegistry rejects it, this is the second lock
    return pg === base || pg.startsWith(`${base}/`);
  }
  return pat === pg;
}

export function checkCoverage(facts: CodeFacts, entries: Capability[]): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, key: string, message: string) => out.push({ rule, key, message });
  const claimed = new Set(entries.flatMap((e) => e.api.map(normalizeApi)));
  const present = new Set(facts.routes.map((r) => normalizeApi(`${r.method} ${r.path}`)));
  const screens = entries.flatMap((e) => e.screens).filter((s) => s.startsWith('/'));

  for (const page of facts.pages) if (!screens.some((s) => pageMatches(s, page))) add('page-uncovered', page, `no capability claims page ${page}`);
  for (const r of facts.routes) {
    if (r.kind === 'public' || r.kind === 'internal') continue;
    if (!claimed.has(normalizeApi(`${r.method} ${r.path}`))) add('route-uncovered', `${r.method.toUpperCase()} ${r.path}`, `no capability claims route ${r.method.toUpperCase()} ${r.path}`);
  }
  for (const e of entries) {
    if (e.status !== 'live') continue;
    for (const a of e.api) if (!present.has(normalizeApi(a))) add('route-dangling', `${e.id} ${a}`, `${e.id} is live but ${a} is not in code`);
  }
  if (facts.mcpTools) {
    // a catalogue row may list several tools ("a; b")
    const tools = new Set(entries.flatMap((e) => (e.mcpTool ? e.mcpTool.split(/\s*[;,]\s*/) : [])));
    for (const t of facts.mcpTools) if (!tools.has(t)) add('tool-uncovered', t, `no capability has mcpTool ${t}`);
  }
  if (facts.planGates) {
    const gates = new Set(entries.map((e) => e.planGate).filter((t): t is string => !!t));
    for (const g of facts.planGates) if (!gates.has(g)) add('plangate-uncovered', g, `no capability has planGate ${g}`);
  }
  return out;
}
