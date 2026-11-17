import { describe, expect, it, vi } from 'vitest';
import { CHUNK_MAX, MAX_CHUNKS, chunkText, vecId } from '../src/core/ai/knowledge';
import { MemoryVectors, ScriptedProvider, bagEmbedder, until, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { apiFor, graphStub, storeId, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { storeEvent, deliver, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
const link = useStoreLink();
const vectors = { v: new MemoryVectors() };
const agent = useAgent({ vectors: () => vectors.v, embedder: () => bagEmbedder });
import { beforeEach } from 'vitest';
beforeEach(() => { vectors.v = new MemoryVectors(); });

const W = (n: number) => `00000000-0000-4000-8000-0000000055${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const FAQ = `الشحن مجاني لأي طلب فوق 500 جنيه، والتوصيل خلال يومين للقاهرة والجيزة.

الاسترجاع متاح خلال 14 يوم من الاستلام بشرط أن يكون المنتج بحالته الأصلية.

مواعيد العمل من العاشرة صباحا حتى العاشرة مساء كل يوم ما عدا الجمعة.`;
const SHORT_FAQ = 'الشحن مجاني لأي طلب فوق 500 جنيه.';
/** A FAQ over the inline limit (3 KB) stays in the vector index; the small ones are read whole (test/chat-agent-context.test.ts). */
const big = (t: string) => `${t}\n\n${'ملحوظة داخلية للمتجر لا علاقة لها بالسؤال '.repeat(90)}`;
const ready = async (ws: string) => (await workspace(ws).getAgentSettings()).knowledgeReady;
async function withKb(ws: string, faq = FAQ) {
  const pn = await agentWorkspace(ws, { faqText: faq });
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 100 });
  await workspace(ws).runDueTasks();
  await until(() => ready(ws));
  return pn;
}

describe('chunking', () => {
  it('splits on paragraphs, merges short ones, cuts long ones, bounds the count', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n ')).toEqual([]);
    expect(chunkText('a\n\nb')).toEqual(['a\nb']);
    const long = `${'كلمة '.repeat(400)}`.trim();
    const parts = chunkText(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= CHUNK_MAX)).toBe(true);
    const sentences = Array.from({ length: 50 }, (_, i) => `الجملة رقم ${i} فيها كلام كتير عن السياسة.`).join(' ');
    expect(chunkText(sentences).every((p) => p.length <= CHUNK_MAX)).toBe(true);
    expect(chunkText(Array.from({ length: 500 }, (_, i) => `فقرة ${i} ${'ك'.repeat(700)}`).join('\n\n')).length).toBe(MAX_CHUNKS);
  });
  it('vector ids are short (Vectorize allows 64 bytes) and unique per workspace', async () => {
    const a = await vecId('ws-a', 'kb', 1, 0);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(await vecId('ws-b', 'kb', 1, 0));
  });
});

describe('FAQ -> chunks -> vectors', () => {
  it('saving the FAQ stages chunks and a task; the task embeds them into this workspace namespace only', async () => {
    const ws = W(1);
    await agentWorkspace(ws, { faqText: FAQ });
    await workspace(ws).runDueTasks();
    await until(() => ready(ws));
    expect(vectors.v.all(`${ws}:kb`).length).toBe(1);
    expect([...vectors.v.data.keys()].sort()).toEqual([`${ws}:catalog`, `${ws}:kb`]); // nothing outside this workspace
    expect(vectors.v.all(`${ws}:kb`)[0]).toHaveLength(32);
    expect((await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM kb_chunks WHERE indexed = 1'))[0]!.n).toBe(1);
  });

  it('the same text saved again does nothing; a changed text makes a new version and replaces the old one (rows and vectors)', async () => {
    const ws = W(2);
    await withKb(ws);
    const first = vectors.v.all(`${ws}:kb`);
    const upserts = vectors.v.upserts;
    await workspace(ws).setAgentSettings({ faqText: FAQ });
    await workspace(ws).runDueTasks();
    expect(vectors.v.upserts).toBe(upserts); // unchanged text: nothing staged, nothing embedded
    expect(await rows(ws, 'SELECT version FROM kb_chunks')).toEqual([{ version: 1 }]);
    await workspace(ws).setAgentSettings({ faqText: 'سياسة جديدة تماما عن الدفع بالبطاقة.' });
    await until(async () => (await rows<{ version: number }>(ws, 'SELECT version FROM kb_chunks'))[0]?.version === 2);
    expect(vectors.v.deleted).toEqual(first);
    expect(vectors.v.all(`${ws}:kb`).length).toBe(1);
    expect(await rows(ws, 'SELECT version FROM kb_chunks')).toEqual([{ version: 2 }]);
  });

  it('while the new version is not in, the old one keeps answering; a failed index run is retried', async () => {
    const ws = W(3);
    const pn = await withKb(ws, big(SHORT_FAQ));
    const m = model([{ text: 'ok' }]);
    vectors.v.failUpserts = 1;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await workspace(ws).setAgentSettings({ faqText: big('الدفع عند الاستلام متاح في كل المحافظات.') });
    await workspace(ws).runDueTasks(); // whoever runs it first (this call or the alarm), the run fails once
    await until(async () => ((await rows<{ attempts: number }>(ws, "SELECT attempts FROM scheduled_tasks WHERE kind = 'kb_index'"))[0]?.attempts ?? 0) >= 1);
    err.mockRestore();
    await say(ws, pn, text('الشحن مجاني لأي طلب'), stubGraph());
    expect(m.calls[0]!.system).toContain('الشحن مجاني لأي طلب');
    // retry succeeds
    await exec(ws, "UPDATE scheduled_tasks SET due_at = 1, lease_until = NULL WHERE kind = 'kb_index'");
    await workspace(ws).runDueTasks();
    await until(async () => (await rows<{ version: number }>(ws, 'SELECT version FROM kb_chunks'))[0]?.version === 2);
    expect(vectors.v.all(`${ws}:kb`).length).toBe((await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM kb_chunks'))[0]!.n);
  });

  it('an emptied FAQ clears the knowledge base', async () => {
    const ws = W(4);
    await withKb(ws);
    await workspace(ws).setAgentSettings({ faqText: '' });
    await workspace(ws).runDueTasks();
    await until(async () => (await rows(ws, 'SELECT 1 FROM kb_chunks')).length === 0);
    expect(vectors.v.all(`${ws}:kb`)).toEqual([]);
    expect(await ready(ws)).toBe(false);
    expect(await rows(ws, 'SELECT 1 FROM kb_chunks')).toEqual([]);
  });
});

describe('retrieval into the prompt', () => {
  it('puts the best chunks (at most 4) into the system prompt; a question with no match adds none', async () => {
    const ws = W(5);
    const faq = Array.from({ length: 6 }, (_, i) => `سياسة الشحن رقم ${i}: ${'التوصيل والشحن '.repeat(30)}${'x'.repeat(i)}`).join('\n\n');
    const pn = await withKb(ws, `${faq}\n\n${'فقرة عن مواعيد العمل والجمعة '.repeat(15)}`);
    const m = model([{ text: 'a' }, { text: 'b' }]);
    const g = stubGraph();
    await say(ws, pn, text('عايز اعرف مواعيد العمل'), g);
    expect(m.calls[0]!.system).toContain('Store knowledge');
    expect(m.calls[0]!.system).toContain('مواعيد العمل');
    expect((m.calls[0]!.system.match(/^\[\d\]/gm) ?? []).length).toBeLessThanOrEqual(4);
    await say(ws, pn, text('qqqq zzzz'), g);
    expect(m.calls[1]!.system).not.toContain('Store knowledge');
  });

  it('only this workspace namespace is ever queried', async () => {
    const a = W(6);
    const b = W(7);
    const pnA = await withKb(a, big(FAQ));
    await withKb(b, big('سياسة أخرى خالص عن الهدايا.'));
    model([{ text: 'x' }]);
    await say(a, pnA, text('الشحن'), stubGraph());
    expect(vectors.v.queries.map((q) => q.namespace)).toEqual([`${a}:kb`]);
  });

  it('degrades without a vector index or embedder: no knowledge base, no error, the customer is still answered', async () => {
    const ws = W(8);
    const pn = await agentWorkspace(ws, { faqText: FAQ });
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 5 });
    const prev = (await import('../src/core/ai/config')).configureAgent({ vectors: () => null });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await workspace(ws).runDueTasks();
      await until(async () => (await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'kb_index'")).length === 0);
      expect(await ready(ws)).toBe(false);
      expect(err.mock.calls.flat().join(' ')).toContain('kb_index_unavailable');
      const m = model([{ text: 'بدون قاعدة معرفة' }]);
      const out = await say(ws, pn, text('الشحن مجاني؟'), stubGraph());
      expect(out.map((s) => s.text)).toEqual(['بدون قاعدة معرفة']);
      expect(m.calls[0]!.system).not.toContain('Store knowledge');
    } finally {
      err.mockRestore();
      (await import('../src/core/ai/config')).configureAgent(prev);
    }
  });

  it('a vector index that fails at question time is skipped, not fatal', async () => {
    const ws = W(9);
    const pn = await withKb(ws, big(FAQ));
    vectors.v.query = async () => { throw new Error('boom 01001234567'); };
    const log: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    model([{ text: 'تمام' }]);
    const out = await say(ws, pn, text('الشحن'), stubGraph());
    err.mockRestore();
    expect(out.map((s) => s.text)).toEqual(['تمام']);
    expect(log.join(' ')).toContain('kb_retrieve_failed');
    expect(log.join(' ')).not.toContain('0100');
  });
});

describe('catalog index', () => {
  const search = (q: string) => ({ tools: [{ name: 'search_catalog', arguments: { query: q } }] });

  it('turning the agent on indexes the catalog; search finds candidates in the index but shows FRESH price and stock from the Store', async () => {
    const ws = W(10);
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 5 });
    await workspace(ws).runDueTasks();
    await until(() => vectors.v.all(`${ws}:catalog`).length === link.fake.catalog.length);
    // the Store changes after indexing: price and stock must come from the Store now
    link.fake.catalog[4] = { ...link.fake.catalog[4]!, title: 'Leather wallet black', titleAr: 'محفظة جلد سوداء', description: 'wallet', priceMinor: 77_700 };
    await workspace(ws).schedule('catalog_embed', 1);
    await workspace(ws).runDueTasks();
    await until(async () => (await rows<{ hash: string }>(ws, "SELECT hash FROM catalog_vectors WHERE retailer_id = 'v5'")).length === 1 && vectors.v.data.get(`${ws}:catalog`)!.get((await rows<{ vec_id: string }>(ws, "SELECT vec_id FROM catalog_vectors WHERE retailer_id = 'v5'"))[0]!.vec_id)!.values.length === 64);
    await new Promise((r) => setTimeout(r, 50));
    link.fake.catalog[4] = { ...link.fake.catalog[4]!, priceMinor: 88_800 };
    link.fake.stock['v5'] = 0;
    const m = model([search('محفظة جلد'), { text: 'ok' }]);
    link.fake.failNext.set('searchProducts', 'unavailable'); // the Store's own search is down: the agent's index is the fallback
    link.fake.calls.length = 0;
    await say(ws, pn, text('عايز محفظة جلد'), stubGraph());
    const result = JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content) as { results: { id: string; price: number; inStock: boolean }[] };
    expect(result.results[0]).toMatchObject({ id: 'v5', price: 888, inStock: false });
    expect(link.fake.count('getProducts')).toBe(1); // the index named candidates, the Store answered
    expect(link.fake.count('listCatalog')).toBe(0); // no walk of the whole catalog
  });

  it('falls back to the plain search when there is no usable index', async () => {
    const ws = W(11);
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 5 });
    const prev = (await import('../src/core/ai/config')).configureAgent({ vectors: () => null });
    try {
      link.fake.failNext.set('searchProducts', 'unavailable');
      const m = model([search('Item 3'), { text: 'ok' }]);
      await say(ws, pn, text('item 3'), stubGraph());
      const r = JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content) as { results: { id: string }[] };
      expect(r.results[0]!.id).toBe('v3');
      expect(link.fake.count('listCatalog')).toBeGreaterThan(0);
    } finally {
      (await import('../src/core/ai/config')).configureAgent(prev);
    }
  });

  it('products removed from the Store leave the index; an EMPTY Store answer never wipes it', async () => {
    const ws = W(12);
    await agentWorkspace(ws);
    await workspace(ws).runDueTasks();
    const total = link.fake.catalog.length;
    await until(async () => (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM catalog_vectors'))[0]!.n === total);
    link.fake.catalog = link.fake.catalog.slice(0, total - 3);
    await workspace(ws).schedule('catalog_embed', 1);
    await workspace(ws).runDueTasks();
    await until(async () => (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM catalog_vectors'))[0]!.n === total - 3);
    expect(vectors.v.all(`${ws}:catalog`).length).toBe(total - 3);
    expect((await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM catalog_vectors'))[0]!.n).toBe(total - 3);
    link.fake.catalog = [];
    await workspace(ws).schedule('catalog_embed', 1);
    await workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 100));
    expect(vectors.v.all(`${ws}:catalog`).length).toBe(total - 3);
  });

  it('unchanged products are not embedded again', async () => {
    const ws = W(13);
    await agentWorkspace(ws);
    await workspace(ws).runDueTasks();
    await until(async () => (await rows<{ n: number }>(ws, 'SELECT count(*) AS n FROM catalog_vectors'))[0]!.n === link.fake.catalog.length);
    const n = vectors.v.upserts;
    await workspace(ws).schedule('catalog_embed', 1);
    await workspace(ws).runDueTasks();
    await new Promise((r) => setTimeout(r, 100));
    expect(vectors.v.upserts).toBe(n);
  });

  it('catalog events schedule a refresh only while the agent is on (no spend otherwise)', async () => {
    const off = storeId(5520);
    const on = storeId(5521);
    for (const [ws, enabled] of [[off, false], [on, true]] as const) {
      const api = await apiFor(ws);
      await agentWorkspace(ws, { enabled });
      await workspace(ws).runDueTasks();
      await new Promise((r) => setTimeout(r, 100));
      await exec(ws, "DELETE FROM scheduled_tasks WHERE kind = 'catalog_embed'");
      const ev = await deliver([storeEvent(ws, 'catalog.product_upserted', { productId: 'p1', variantIds: ['v1'], updatedAt: new Date().toISOString() })]);
      expect(ev.explicitAcks).toHaveLength(1);
      expect((await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'catalog_embed'")).length, String(enabled)).toBe(enabled ? 1 : 0);
      void api;
    }
    void graphStub;
  });
});
