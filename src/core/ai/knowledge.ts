/**
 * What the agent knows besides the conversation: the merchant's FAQ/policy text (chunks -> embeddings -> a vector index, one
 * namespace per workspace) and the product catalog (a vector index only to FIND products; their price and stock are read from
 * the Store when the tool runs). Everything degrades quietly: no vector index or no embedder bound = no knowledge base and the
 * plain catalog search, never an error towards the customer.
 */
import { BACKUP_TIME_ZONE, nextLocalHour, sha256Hex } from '../backup';
import { errClass, alert } from '../observability';
import { serviceOpen } from './gates'; // a package AND not suspended / Store-held (STORE-STANDING-1)
import { addTask } from '../scheduler';
import type { CatalogRow } from '../store-bridge';
import { bridgeFor } from '../store-link';
import type { LinkHost } from '../store-link/host';
import { agentConfig } from './config';
import { maskForModel } from './mask';
import { getAgentState, putAgentState, readAgentSettings } from './settings';

export const KB_TOP = 4;
/** Cosine scores below this are noise for bge-m3 on short Arabic text. */
export const KB_MIN_SCORE = 0.35;
export const CHUNK_TARGET = 600;
export const CHUNK_MAX = 800;
export const MAX_CHUNKS = 60;
const EMBED_BATCH = 20;
const BATCHES_PER_RUN = 3;
const CATALOG_PAGES = 20;
const CATALOG_EMBED_HOUR_LOCAL = 4;

/** Vectorize ids are at most 64 bytes: a hash keeps them short and unique across workspaces. */
export const vecId = async (...parts: (string | number)[]): Promise<string> => (await sha256Hex(parts.join('\u0001'))).slice(0, 32);

/** Paragraphs first (blank lines), then sentences; pieces are merged up to ~600 characters, never above 800. */
export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const pieces: string[] = [];
  for (const para of clean.split(/\n\s*\n/)) {
    const p = para.replace(/[ \t]+/g, ' ').trim();
    if (!p) continue;
    if (p.length <= CHUNK_MAX) {
      pieces.push(p);
      continue;
    }
    for (const sentence of p.split(/(?<=[.!?؟؛。\n])\s+/)) {
      let rest = sentence.trim();
      while (rest.length > CHUNK_MAX) {
        const cut = Math.max(rest.lastIndexOf(' ', CHUNK_MAX), CHUNK_TARGET);
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
    }
  }
  const chunks: string[] = [];
  for (const piece of pieces) {
    const last = chunks.at(-1);
    if (last !== undefined && last.length + 1 + piece.length <= CHUNK_TARGET) chunks[chunks.length - 1] = `${last}\n${piece}`;
    else chunks.push(piece);
  }
  return chunks.slice(0, MAX_CHUNKS);
}

const nsKb = (ws: string) => `${ws}:kb`;
const nsCatalog = (ws: string) => `${ws}:catalog`;
const num = (v: string | null) => Number(v ?? 0) || 0;

/** The FAQ text changed: a new version of chunks is written (call inside a transaction) and indexing is scheduled. */
export function stageFaq(host: Pick<LinkHost, 'sql'>, chunks: { text: string; vecId: string }[], now: number): void {
  const version = num(getAgentState(host.sql, 'kb.version')) + 1;
  putAgentState(host.sql, 'kb.version', String(version));
  chunks.forEach((c, i) => host.sql.exec('INSERT INTO kb_chunks (version, idx, vec_id, text) VALUES (?, ?, ?, ?)', version, i, c.vecId, c.text));
  addTask(host.sql, 'kb_index', now);
}

/** Builds the chunk list (with ids) for a FAQ text. Async because the ids are hashes. */
export async function prepareChunks(workspaceId: string, nextVersion: number, faq: string): Promise<{ text: string; vecId: string }[]> {
  return Promise.all(chunkText(faq).map(async (text, i) => ({ text, vecId: await vecId(workspaceId, 'kb', nextVersion, i) })));
}
export const nextKbVersion = (sql: Pick<LinkHost, 'sql'>['sql']): number => num(getAgentState(sql, 'kb.version')) + 1;

/** The current FAQ is searchable (all its chunks embedded, or there is no FAQ). */
export function knowledgeReady(sql: Pick<LinkHost, 'sql'>['sql']): boolean {
  const version = num(getAgentState(sql, 'kb.version'));
  return version > 0 && num(getAgentState(sql, 'kb.live')) === version && sql.exec('SELECT 1 FROM kb_chunks WHERE version = ?', version).toArray().length > 0;
}

/**
 * Embeds the current version's chunks and, when all are in, makes it the live one and drops the old version (rows and vectors).
 * Searches keep using the previous live version until then. Returns when to run again (more to embed), or undefined.
 */
export async function runKbIndex(host: LinkHost, now: number): Promise<number | undefined> {
  const cfg = agentConfig();
  const version = num(getAgentState(host.sql, 'kb.version'));
  if (!version) return undefined;
  // Background Workers AI spend stops with the package (WA-NOFREE-1). Dropped, not retried: the next FAQ save (or a new package then a save) indexes again.
  if (!serviceOpen(host, now)) return undefined;
  const store = cfg.vectors(host.env);
  const embed = cfg.embedder(host.env);
  const count = host.sql.exec<{ n: number }>('SELECT count(*) AS n FROM kb_chunks WHERE version = ?', version).one().n;
  if (count > 0 && (!store || !embed)) {
    alert('kb_index_unavailable', { workspace: host.workspaceId });
    return undefined; // no index bound: the agent runs without a knowledge base; saving the FAQ again after binding retries
  }
  for (let b = 0; b < BATCHES_PER_RUN; b++) {
    const todo = host.sql.exec<{ id: number; vec_id: string; text: string }>('SELECT id, vec_id, text FROM kb_chunks WHERE version = ? AND indexed = 0 ORDER BY idx LIMIT ?', version, EMBED_BATCH).toArray();
    if (!todo.length) break;
    const vectors = await embed!(todo.map((t) => t.text));
    await store!.upsert(todo.map((t, i) => ({ id: t.vec_id, values: vectors[i]!, namespace: nsKb(host.workspaceId) })));
    host.storage.transactionSync(() => {
      for (const t of todo) host.sql.exec('UPDATE kb_chunks SET indexed = 1 WHERE id = ?', t.id);
    });
  }
  if (host.sql.exec('SELECT 1 FROM kb_chunks WHERE version = ? AND indexed = 0 LIMIT 1', version).toArray().length) return now + 1000;
  // every chunk of the new version is in: it goes live, the old one goes away
  const old = host.sql.exec<{ vec_id: string }>('SELECT vec_id FROM kb_chunks WHERE version < ?', version).toArray().map((r) => r.vec_id);
  host.storage.transactionSync(() => putAgentState(host.sql, 'kb.live', String(version)));
  if (old.length && store) {
    for (let i = 0; i < old.length; i += 100) await store.deleteByIds(old.slice(i, i + 100));
  }
  host.storage.transactionSync(() => host.sql.exec('DELETE FROM kb_chunks WHERE version < ?', version));
  return undefined;
}

/** Up to four FAQ chunks that answer the customer's words; [] when there is no knowledge base or anything goes wrong. */
export async function retrieveKnowledge(host: LinkHost, query: string): Promise<string[]> {
  try {
    const live = num(getAgentState(host.sql, 'kb.live'));
    if (!live || !query.trim()) return [];
    const cfg = agentConfig();
    const store = cfg.vectors(host.env);
    const embed = cfg.embedder(host.env);
    if (!store || !embed) return [];
    const [vector] = await embed([maskForModel(query).slice(0, 400)]); // the same masker as before any model: a phone or e-mail in the question never reaches the embedder
    if (!vector) return [];
    const hits = await store.query(vector, { namespace: nsKb(host.workspaceId), topK: 8 });
    const good = hits.filter((h) => h.score >= KB_MIN_SCORE);
    if (!good.length) return [];
    const rows = host.sql.exec<{ vec_id: string; text: string }>(`SELECT vec_id, text FROM kb_chunks WHERE version = ? AND vec_id IN (${good.map(() => '?').join(',')})`, live, ...good.map((h) => h.id)).toArray();
    const byId = new Map(rows.map((r) => [r.vec_id, r.text]));
    return good.map((h) => byId.get(h.id)).filter((t): t is string => !!t).slice(0, KB_TOP);
  } catch (err) {
    alert('kb_retrieve_failed', { workspace: host.workspaceId, error: errClass(err) });
    return [];
  }
}

// ---- catalog index (finding products; the Store stays the truth for price and stock) --------------------------------------

const catalogDoc = (r: CatalogRow): string => [r.title, r.titleAr, r.brand, r.description?.slice(0, 300)].filter(Boolean).join(' | ');

/** Asks for a (debounced) refresh of the catalog index. Does nothing while the agent is off, so no embedding spend. */
export function scheduleCatalogEmbed(host: Pick<LinkHost, 'sql'>, now: number, delayMs = 60_000): void {
  if (!serviceOpen(host, now)) return; // no package, no background AI spend (WA-NOFREE-1)
  if (agentConfig().copy && readAgentSettings(host.sql).enabled) addTask(host.sql, 'catalog_embed', now + delayMs);
}

/** Walks the Store's catalog, embeds what is new or changed, removes what is gone. Nightly; also after catalog events. */
export async function runCatalogEmbed(host: LinkHost, now: number): Promise<number | undefined> {
  const next = nextLocalHour(now + 3_600_000, CATALOG_EMBED_HOUR_LOCAL, BACKUP_TIME_ZONE);
  if (!agentConfig().copy || !readAgentSettings(host.sql).enabled) return undefined;
  if (!serviceOpen(host, now)) return next; // no package, no embedding spend (WA-NOFREE-1); the nightly chain survives
  const cfg = agentConfig();
  const store = cfg.vectors(host.env);
  const embed = cfg.embedder(host.env);
  const bridge = bridgeFor(host.env);
  if (!store || !embed || !bridge) return undefined;
  const rows: CatalogRow[] = [];
  let cursor: string | null = null;
  for (let p = 0; p < CATALOG_PAGES; p++) {
    const res = await bridge.listCatalog(host.workspaceId, cursor, 100);
    if (!res.ok) throw new Error(`catalog read from the Store failed: ${res.reason}`); // retried with backoff
    rows.push(...res.value.items);
    cursor = res.value.nextCursor;
    if (!cursor) break;
  }
  if (cursor) throw new Error('catalog read from the Store did not finish');
  const have = new Map(host.sql.exec<{ retailer_id: string; vec_id: string; hash: string }>('SELECT retailer_id, vec_id, hash FROM catalog_vectors').toArray().map((r) => [r.retailer_id, r]));
  const changed: { row: CatalogRow; doc: string; hash: string; id: string }[] = [];
  for (const row of rows) {
    const doc = catalogDoc(row);
    const hash = (await sha256Hex(doc)).slice(0, 16);
    if (have.get(row.retailerId)?.hash !== hash) changed.push({ row, doc, hash, id: have.get(row.retailerId)?.vec_id ?? (await vecId(host.workspaceId, 'catalog', row.retailerId)) });
  }
  for (let i = 0; i < changed.length; i += EMBED_BATCH) {
    const part = changed.slice(i, i + EMBED_BATCH);
    const vectors = await embed(part.map((c) => c.doc));
    await store.upsert(part.map((c, j) => ({ id: c.id, values: vectors[j]!, namespace: nsCatalog(host.workspaceId), metadata: { productId: c.row.productId } })));
    host.storage.transactionSync(() => {
      for (const c of part) host.sql.exec('INSERT INTO catalog_vectors (retailer_id, vec_id, hash) VALUES (?, ?, ?) ON CONFLICT(retailer_id) DO UPDATE SET hash = excluded.hash', c.row.retailerId, c.id, c.hash);
    });
  }
  // gone from the Store: only when the Store answered with something (an empty answer never wipes the index)
  if (rows.length) {
    const live = new Set(rows.map((r) => r.retailerId));
    const gone = [...have.values()].filter((h) => !live.has(h.retailer_id));
    for (let i = 0; i < gone.length; i += 100) await store.deleteByIds(gone.slice(i, i + 100).map((g) => g.vec_id));
    host.storage.transactionSync(() => {
      for (const g of gone) host.sql.exec('DELETE FROM catalog_vectors WHERE retailer_id = ?', g.retailer_id);
    });
  }
  return next;
}

/** Product ids the vector index thinks match, best first; null when the index is unavailable or empty (the caller falls back). */
/** Retailer ids of the catalogue rows closest in meaning to `query` (best first), or null when there is no index / no good hit. */
export async function catalogCandidates(host: LinkHost, query: string): Promise<string[] | null> {
  try {
    if (!host.sql.exec('SELECT 1 FROM catalog_vectors LIMIT 1').toArray().length) return null;
    const cfg = agentConfig();
    const store = cfg.vectors(host.env);
    const embed = cfg.embedder(host.env);
    if (!store || !embed) return null;
    const [vector] = await embed([maskForModel(query).slice(0, 200)]);
    if (!vector) return null;
    const hits = await store.query(vector, { namespace: nsCatalog(host.workspaceId), topK: 8 });
    // A hit's vector id maps to the RETAILER id in catalog_vectors (the id the Store's getProducts answers to; for a product with
    // variants that is a variant id, never the product id). Returned in score order.
    const good = hits.filter((h) => h.score >= KB_MIN_SCORE).map((h) => h.id);
    if (!good.length) return null;
    const byVec = new Map(host.sql.exec<{ retailer_id: string; vec_id: string }>(`SELECT retailer_id, vec_id FROM catalog_vectors WHERE vec_id IN (${good.map(() => '?').join(',')})`, ...good).toArray().map((r) => [r.vec_id, r.retailer_id]));
    const ids = [...new Set(good.map((v) => byVec.get(v)).filter((x): x is string => !!x))];
    return ids.length ? ids : null;
  } catch (err) {
    alert('catalog_vector_search_failed', { workspace: host.workspaceId, error: errClass(err) });
    return null;
  }
}
