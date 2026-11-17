/**
 * Help helpers (plan 4 Task A11). No second front-matter parser: this consumes `parseHelpFrontMatter` / `toHelpArticle` / `helpUrl`
 * from the capability modules. The engine does not search; the adapter owns the index and returns `HelpHit`s, and this module only
 * prepares documents for indexing and judges whether the hits ground an answer.
 */
import { helpUrl } from '../capability';
import { parseHelpFrontMatter, toHelpArticle } from '../help-article';
import { sha256Hex, canonicalJson } from './release';
import type { HelpHit, Locale } from './types';

export interface HelpDoc { articleId: string; locale: Locale; title: string; url: string; appPath: string | null; capabilityIds: string[]; body: string }

export function helpDoc(slug: string, lang: Locale, raw: string): HelpDoc {
  const art = toHelpArticle(slug, lang, raw);
  const { data, body } = parseHelpFrontMatter(raw);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = typeof data.title === 'string' && data.title ? data.title : heading ?? slug;
  return { articleId: slug, locale: lang, title, url: helpUrl(slug, lang), appPath: art.appPath ?? null, capabilityIds: art.capabilities.map((c) => c.id), body };
}

export const CHUNK_MAX = 800;

/** Heading-aware chunks of at most 800 chars: a heading starts a chunk, paragraphs are packed, an over-long paragraph is hard-split. */
export function chunkHelp(doc: HelpDoc): Array<{ id: string; text: string }> {
  const out: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
  const push = (para: string) => {
    for (let i = 0; i < para.length; i += CHUNK_MAX) {
      const part = para.slice(i, i + CHUNK_MAX);
      if (cur && cur.length + part.length + 2 > CHUNK_MAX) flush();
      cur += (cur ? '\n\n' : '') + part;
    }
  };
  for (const para of doc.body.split(/\n{2,}/)) {
    if (/^#{1,6}\s/.test(para.trim())) flush();
    push(para.trim());
  }
  flush();
  return out.map((text, i) => ({ id: `${doc.articleId}:${doc.locale}:${i}`, text }));
}

export async function corpusHash(docs: HelpDoc[]): Promise<string> {
  const rows = docs.map((d) => ({ id: d.articleId, l: d.locale, t: d.title, b: d.body })).sort((a, b) => (a.id + a.l).localeCompare(b.id + b.l));
  return sha256Hex(canonicalJson(rows));
}

/** Same floor as Ebda Chat `KB_MIN_SCORE`: below 0.35 the corpus does not cover the question and the assistant must say so. */
export const NOT_COVERED_FLOOR = 0.35;
export const COVERED_FROM = 0.55;
export function groundingVerdict(hits: HelpHit[]): 'covered' | 'weak' | 'not_covered' {
  const top = hits.reduce((m, h) => Math.max(m, h.score), 0);
  if (top < NOT_COVERED_FLOOR) return 'not_covered';
  return top < COVERED_FROM ? 'weak' : 'covered';
}
