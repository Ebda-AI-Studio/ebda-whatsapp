import type { Capability, GuardConfig, Violation } from './capability';

const unquote = (s: string): string => {
  const t = s.trim();
  return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

/** Minimal YAML subset: scalars, quoted scalars, block lists of strings. Unknown keys are kept (callers ignore them). No front matter -> data {}. */
export function parseHelpFrontMatter(raw: string): { data: Record<string, string | string[]>; body: string } {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') {
      listKey = kv[1]!;
      data[listKey] = [];
    } else {
      listKey = null;
      data[kv[1]!] = unquote(kv[2]!);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export interface HelpArticle {
  slug: string;
  lang: 'ar' | 'en';
  capabilities: { id: string; version: number }[];
  appPath?: string;
}

export function toHelpArticle(slug: string, lang: 'ar' | 'en', raw: string): HelpArticle {
  const { data } = parseHelpFrontMatter(raw);
  const list = Array.isArray(data.capabilities) ? data.capabilities : [];
  const capabilities = list.flatMap((s) => {
    const m = /^(\S+)@(\d+)$/.exec(s);
    return m ? [{ id: m[1]!, version: Number(m[2]) }] : [];
  });
  return { slug, lang, capabilities, ...(typeof data.appPath === 'string' ? { appPath: data.appPath } : {}) };
}

const needsHelp = (e: Capability, exempt: string[]): boolean =>
  e.status === 'live' && e.roles.some((r) => r !== 'super_admin' && r !== 'operator') && !exempt.includes(e.area);

export function checkHelp(entries: Capability[], articles: HelpArticle[], cfg: Pick<GuardConfig, 'helpExemptAreas'>): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, key: string, message: string) => out.push({ rule, key, message });
  const bySlug = new Map<string, HelpArticle[]>();
  for (const a of articles) bySlug.set(a.slug, [...(bySlug.get(a.slug) ?? []), a]);
  const twinReported = new Set<string>();

  for (const e of entries) {
    if (!needsHelp(e, cfg.helpExemptAreas)) continue;
    if (!e.helpArticle) {
      add('help-missing', e.id, `${e.id} is live and has no help article`);
      continue;
    }
    const arts = bySlug.get(e.helpArticle) ?? [];
    if (arts.length === 0) {
      add('help-article-absent', e.id, `${e.id}: article ${e.helpArticle} does not exist in ar or en`);
      continue;
    }
    const langs = new Set(arts.map((a) => a.lang));
    if (langs.size < 2 && !twinReported.has(e.helpArticle)) {
      twinReported.add(e.helpArticle);
      add('help-twin-missing', e.helpArticle, `${e.helpArticle} exists in ${[...langs][0]} only; it needs both ar and en`);
    }
    const listed = arts.map((a) => a.capabilities.find((c) => c.id === e.id));
    if (listed.some((c) => !c)) add('help-unlinked', e.id, `${e.helpArticle} does not list ${e.id} in its capabilities`);
    else if (listed.some((c) => c!.version !== e.version)) add('help-stale', e.id, `${e.helpArticle} lists an older version of ${e.id} than the registry (${e.version})`);
  }

  const ids = new Set(entries.map((e) => e.id));
  const orphans = new Set<string>();
  for (const a of articles) for (const c of a.capabilities) if (!ids.has(c.id)) orphans.add(`${a.slug} ${c.id}`);
  for (const k of orphans) add('help-orphan', k, `article lists a capability with no registry entry: ${k}`);
  return out;
}
