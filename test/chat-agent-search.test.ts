import { describe, expect, it } from 'vitest';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

const link = useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000071${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const agentWs = async (ws: string, settings: Record<string, unknown> = {}) => {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};
const toolResult = (m: ScriptedProvider, name = 'search_catalog') => JSON.parse((m.calls[1]!.messages.filter((x) => x.role === 'tool' && (x as { name: string }).name === name).at(-1) as { content: string }).content);

describe('search_catalog uses the Store search first (Ruling CHAT-AGENT-1)', () => {
  it('calls searchProducts with the query (the answer is the Store\'s, not a catalogue scan)', async () => {
    const ws = W(1);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item 3' } }] }, { text: 'تمام' }]);
    await say(ws, pn, text('عايز item 3'), stubGraph());
    expect(link.fake.count('searchProducts')).toBe(1);
    expect(link.fake.lastCall('searchProducts')).toEqual([ws, 'item 3', { limit: 5 }]);
    expect(toolResult(m).results[0]).toMatchObject({ id: 'v3', price: 110, inStock: true });
  });

  it('a budget in the store currency becomes a price ceiling in piasters', async () => {
    const ws = W(2);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item', maxPrice: 105 } }] }, { text: 'ده المتاح' }]);
    await say(ws, pn, text('عايز item تحت 105'), stubGraph());
    expect(link.fake.lastCall('searchProducts')).toEqual([ws, 'item', { limit: 5, maxPriceMinor: 10500 }]);
    expect((toolResult(m).results as { price: number }[]).every((r) => r.price <= 105)).toBe(true);
  });

  it('a meaning match from the Store (no shared word) is returned as is', async () => {
    const ws = W(3);
    const pn = await agentWs(ws);
    link.fake.searchImpl = () => [link.fake.catalog[4]!];
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'هدية لمراتي' } }] }, { text: 'اقترحلك ده' }]);
    await say(ws, pn, text('عايز هدية لمراتي'), stubGraph());
    expect(toolResult(m).results.map((r: { id: string }) => r.id)).toEqual(['v5']);
  });

  it('an empty Store answer is a real negative (no uncertainty flag)', async () => {
    const ws = W(4);
    const pn = await agentWs(ws);
    link.fake.searchImpl = () => [];
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'طيارة' } }] }, { text: 'مش موجود عندنا' }]);
    await say(ws, pn, text('عندكم طيارة؟'), stubGraph());
    expect(toolResult(m)).toEqual({ results: [] }); // a fallback miss would carry uncertain: true
  });

  it('when the Store search is unavailable it falls back to the catalogue and marks the answer uncertain, never a flat "we do not have it"', async () => {
    const ws = W(5);
    const pn = await agentWs(ws);
    link.fake.failNext.set('searchProducts', 'unavailable');
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'طيارة' } }] }, { text: 'هشوفلك' }]);
    await say(ws, pn, text('عندكم طيارة؟'), stubGraph());
    expect(link.fake.count('listCatalog')).toBeGreaterThan(0);
    expect(toolResult(m)).toEqual({ results: [], uncertain: true });
  });

  it('a fallback hit is still returned (with the uncertain flag off) and honours the budget', async () => {
    const ws = W(6);
    const pn = await agentWs(ws);
    link.fake.failNext.set('searchProducts', 'unavailable');
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item', maxPrice: 105 } }] }, { text: 'تمام' }]);
    await say(ws, pn, text('item'), stubGraph());
    const r = toolResult(m) as { results: { price: number }[] };
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((x) => x.price <= 105)).toBe(true);
  });

  it('a catalogue larger than the fallback can read is marked incomplete instead of silently truncated (D2)', async () => {
    const ws = W(7);
    const pn = await agentWs(ws);
    const rows = Array.from({ length: 700 }, (_, i) => ({ ...link.fake.catalog[0]!, retailerId: `big${i}`, productId: `bp${i}`, title: `Thing ${i}` }));
    link.fake.catalog = rows;
    link.fake.stock = Object.fromEntries(rows.map((r) => [r.retailerId, 5]));
    link.fake.failNext.set('searchProducts', 'unavailable');
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'طيارة' } }] }, { text: 'هشوفلك' }]);
    await say(ws, pn, text('طيارة'), stubGraph());
    expect(toolResult(m)).toEqual({ results: [], uncertain: true, incomplete: true });
  });

  it('the prompt tells the model what an uncertain search means', async () => {
    const ws = W(8);
    const pn = await agentWs(ws);
    const m = model([{ text: 'أهلا' }]);
    await say(ws, pn, text('hi'), stubGraph());
    expect(m.calls[0]!.system).toMatch(/uncertain/);
  });
});
