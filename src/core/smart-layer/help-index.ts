/**
 * Help grounding for the assistant: the bundled corpus (docs/help, built into assistant/ by scripts/build-help-corpus.mjs and passed in by the route) is embedded into the product's Vectorize
 * index under the shared namespace `__help__`. Indexing is skip-if-unchanged (corpus hash in D1 `platform_flags` `sl:help-hash`) and removes the
 * vectors of chunks that no longer exist (`sl:help-ids`). Search embeds the MASKED question and returns the chunk text from vector metadata.
 */
import type { HelpHit, Locale } from '../../../foundation/smart-layer/types';
import { maskForModel } from '../../../foundation/smart-layer/rails/mask';
import { foldArabic } from '../../../foundation/text';
import type { Env } from '../../env';
import { vecId } from '../ai/knowledge';

export type HelpChunk = { id: string; text: string };
export type HelpCorpusDoc = { articleId: string; locale: Locale; title: string; url: string; appPath: string | null; capabilityIds: string[]; chunks: HelpChunk[] };
export type HelpCorpus = { hash: string; docs: HelpCorpusDoc[] };

export const HELP_NAMESPACE = '__help__';
export const HASH_KEY = 'sl:help-hash';
export const IDS_KEY = 'sl:help-ids';
const EMBED_MODEL = '@cf/baai/bge-m3';
const BATCH = 20;

type Vec = Pick<Vectorize, 'upsert' | 'query' | 'deleteByIds'>;
type Embed = (texts: string[]) => Promise<number[][]>;
export type HelpDeps = { db: D1Database; vectors: Vec | undefined; embed: Embed | undefined };

export function helpDeps(env: Env): HelpDeps {
  const ai = env.AI;
  return {
    db: env.DB,
    vectors: env.VECTORIZE,
    embed: ai ? async (texts) => {
      const out = (await ai.run(EMBED_MODEL as never, { text: texts } as never)) as unknown as { data?: number[][] };
      if (!out.data || out.data.length !== texts.length) throw new Error('embedding answer malformed');
      return out.data;
    } : undefined,
  };
}

const getFlag = async (db: D1Database, key: string): Promise<string | null> => (await db.prepare('SELECT value FROM platform_flags WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null;
const putFlag = (db: D1Database, key: string, value: string) => db.prepare("INSERT INTO platform_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'help-index') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(key, value, Date.now()).run();

/** Embeds the corpus when its hash changed. Returns 'skipped' (same hash), 'indexed', or 'unavailable' (no index or no model bound: answers then have no help grounding). */
export async function ensureHelpIndex(d: HelpDeps, corpus: HelpCorpus): Promise<'skipped' | 'indexed' | 'unavailable'> {
  if (!d.vectors || !d.embed) return 'unavailable';
  if ((await getFlag(d.db, HASH_KEY)) === corpus.hash) return 'skipped';
  const rows: Array<{ id: string; text: string; doc: HelpCorpusDoc }> = [];
  for (const doc of corpus.docs) for (const c of doc.chunks) rows.push({ id: await vecId('help', c.id), text: c.text, doc });
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    const values = await d.embed(part.map((r) => r.text));
    await d.vectors.upsert(part.map((r, j) => ({
      id: r.id, values: values[j]!, namespace: HELP_NAMESPACE,
      metadata: { articleId: r.doc.articleId, locale: r.doc.locale, title: r.doc.title, url: r.doc.url, appPath: r.doc.appPath ?? '', text: r.text },
    })));
  }
  const now = new Set(rows.map((r) => r.id));
  const before = JSON.parse((await getFlag(d.db, IDS_KEY)) ?? '[]') as string[];
  const stale = before.filter((id) => !now.has(id));
  for (let i = 0; i < stale.length; i += 100) await d.vectors.deleteByIds(stale.slice(i, i + 100));
  await putFlag(d.db, IDS_KEY, JSON.stringify([...now]));
  await putFlag(d.db, HASH_KEY, corpus.hash); // last: a half-finished pass is simply run again
  return 'indexed';
}

export async function helpSearch(d: HelpDeps, q: string, locale: Locale, k: number): Promise<HelpHit[]> {
  if (!d.vectors || !d.embed || !q.trim()) return [];
  const [v] = await d.embed([maskForModel(q).slice(0, 400)]);
  if (!v) return [];
  const r = await d.vectors.query(v, { namespace: HELP_NAMESPACE, topK: Math.max(k * 3, 12), returnMetadata: 'all' });
  return r.matches
    .filter((m) => m.metadata?.locale === locale)
    .slice(0, k)
    .map((m) => {
      const md = m.metadata as Record<string, string>;
      return { articleId: md.articleId!, title: md.title!, url: md.url!, appPath: md.appPath || null, text: md.text!, score: m.score };
    });
}

/** Figures the help guides state (24 hours, 14 days, 150 messages ...): typed sources for the binding-claim rail, per guide. A sentence may repeat a documented figure; an invented one is replaced by a pointer. */
export function helpFigureSources(corpus: HelpCorpus): Array<{ kind: 'limit'; key: string; text: { ar: string; en: string }; values: string[] }> {
  const by = new Map<string, { title: string; values: Set<string> }>();
  for (const d of corpus.docs) {
    const e = by.get(d.articleId) ?? { title: d.title, values: new Set<string>() };
    for (const c of d.chunks) for (const m of foldArabic(c.text).matchAll(/\d+(?:[.,]\d+)*/g)) e.values.add(m[0]);
    by.set(d.articleId, e);
  }
  return [...by].map(([key, e]) => ({ kind: 'limit' as const, key: `help:${key}`, text: { ar: e.title, en: e.title }, values: [...e.values] }));
}
