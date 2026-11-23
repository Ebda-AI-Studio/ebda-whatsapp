import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BUDGET, recommendArgs, recommendProducts, recommendToolDef } from '../src/core/ai/recommend';
import { migrate } from '../src/core/do-migrations';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { useApiKey } from './helpers/api';
import { CAT, freshMeta, graph } from './helpers/catalogue';
import { BUYER_KEY_1, WA_1, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

/** Product recommendations in the Chat agent: what is suggested, to whom, how often, and what is never suggested. */
useApiKey();
const link = useStoreLink();
const agent = useAgent();
beforeEach(() => freshMeta());
const W = (n: number) => `00000000-0000-4000-8000-0000000061${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;

async function shop(ws: string, settings: Record<string, unknown> = {}) {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  await workspace(ws).setStoreLinkSettings({ catalogId: CAT }, { catalogWabaId: 'waba-1' });
  graph();
  await workspace(ws).schedule('catalog_reconcile', Date.now() - 1);
  await workspace(ws).runDueTasks(Date.now());
  return pn;
}
const rec = (args: Record<string, unknown>) => ({ name: 'recommend_products', arguments: args });
const retailerIdsIn = (out: { body: Record<string, any> }[]) => out.flatMap((s) => {
  const i = s.body.interactive as { type?: string; action?: Record<string, any> } | undefined;
  if (i?.type === 'product') return [i.action!.product_retailer_id as string];
  if (i?.type === 'product_list') return (i.action!.sections as { product_items: { product_retailer_id: string }[] }[]).flatMap((x) => x.product_items.map((p) => p.product_retailer_id));
  return [];
});
const lastTool = (m: ScriptedProvider) => JSON.parse((m.calls.at(-1)!.messages.at(-1) as { content: string }).content) as Record<string, any>;

describe('recommend_products', () => {
  it('"عايز حاجة شبه دي" (similar): cards for what the Store returns, priced by the Store', async () => {
    const id = W(1);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2', 'v3'];
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'دول قريبين منه 👇' }]);
    const out = await say(id, pn, text('عايز حاجة شبه v1 بس مختلفة'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v3']);
    expect(link.fake.lastCall('getRecommendations')).toEqual([id, { seedIds: ['v1'], mode: 'similar', limit: 8 }]);
    expect(lastTool(m).products.map((p: { id: string; price: number }) => [p.id, p.price])).toEqual([['v2', 105], ['v3', 110]]);
  });

  it('Franco ("a3mel eh law el fostan khalas?") and Egyptian asks get the same plumbing; the persona stays in the prompt', async () => {
    const id = W(2);
    const pn = await shop(id, { persona: 'انتي مساعدة بتتكلم بالمصري وبتقولي يا فندم' });
    link.fake.recs.v1 = ['v4'];
    const m = model([{ tools: [rec({ basis: 'complement', productId: 'v1' })] }, { text: 'ممكن يعجبك ده كمان يا فندم' }]);
    const out = await say(id, pn, text('el fostan khalas, 3ayez 7aga tet7at ma3ah'), graph());
    expect(retailerIdsIn(out)).toEqual(['v4']);
    expect(m.calls[0]!.system).toContain('انتي مساعدة بتتكلم بالمصري');
    expect(m.calls[0]!.system).toContain('recommend_products');
    expect(m.calls[0]!.tools.map((t) => t.name)).toContain('recommend_products');
  });

  it('never recommends an out-of-stock, inactive or non-public product (the Store drops them; the agent re-checks stock)', async () => {
    const id = W(3);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2', 'v3', 'v4', 'v5'];
    link.fake.stock.v3 = 0; // out of stock
    link.fake.hidden.add('v4'); // inactive / private: the Store re-read drops it
    model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v5']);
  });

  it('when nothing is in stock it says so plainly and sends no cards', async () => {
    const id = W(4);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2'];
    link.fake.stock.v2 = 0;
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'مفيش حاجة شبهه متاحة دلوقتي' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'nothing_to_recommend' });
  });

  it('the tenant is the workspace store, never the model: a store id in the arguments is ignored', async () => {
    const id = W(5);
    const pn = await shop(id);
    link.fake.recs.v1 = ['v2'];
    model([{ tools: [rec({ basis: 'similar', productId: 'v1', storeId: '99999999-9999-4999-8999-999999999999', phoneE164: '+201111111111' })] }, { text: 'تمام' }]);
    await say(id, pn, text('حاجة شبهه'), graph());
    const [store, req] = link.fake.lastCall('getRecommendations') as [string, Record<string, unknown>];
    expect(store).toBe(id);
    expect(Object.keys(req).sort()).toEqual(['limit', 'mode', 'seedIds']);
  });

  it('a Store that refuses (not linked / unavailable) never leaks an error text to the customer path: the model gets store_unavailable', async () => {
    const id = W(6);
    const pn = await shop(id);
    link.fake.failNext.set('getRecommendations', 'unavailable');
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'هراجع وأرد عليك' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'store_unavailable' });
  });

  it('the merchant toggle: off means the tool is not offered and a call made anyway does nothing', async () => {
    const id = W(7);
    const pn = await shop(id, { recommendProducts: false });
    link.fake.recs.v1 = ['v2'];
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(m.calls[0]!.tools.map((t) => t.name)).not.toContain('recommend_products');
    expect(lastTool(m)).toMatchObject({ error: 'unavailable' });
    expect(retailerIdsIn(out)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
  });

  it('is on by default for a workspace that never saved the setting', async () => {
    const id = W(8);
    const pn = await shop(id);
    expect((await rows<{ n: number }>(id, "SELECT count(*) AS n FROM agent_state WHERE key = 'setting.recommendProducts' AND value = '0'"))[0]!.n).toBe(0);
    model([{ text: 'تمام' }]);
    const m = agent.model as ScriptedProvider;
    await say(id, pn, text('اهلا'), graph());
    expect(m.calls[0]!.tools.map((t) => t.name)).toContain('recommend_products');
  });

  it('rations suggestions: three sets in 24 h, the fourth is refused; and the same product is never suggested twice', async () => {
    const id = W(9);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'], v5: ['v6'], v7: ['v8'] };
    const g = graph();
    const ask = (seed: string) => rec({ basis: 'similar', productId: seed });
    const m = model([
      { tools: [ask('v1')] }, { text: 'a' }, { tools: [ask('v1')] }, { text: 'b' }, // repeat: v2 was already suggested
      { tools: [ask('v3')] }, { text: 'c' }, { tools: [ask('v5')] }, { text: 'd' }, { tools: [ask('v7')] }, { text: 'e' },
    ]);
    expect(retailerIdsIn(await say(id, pn, text('1'), g))).toEqual(['v2']);
    expect(retailerIdsIn(await say(id, pn, text('2'), g))).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'nothing_to_recommend' });
    expect(retailerIdsIn(await say(id, pn, text('3'), g))).toEqual(['v4']);
    expect(retailerIdsIn(await say(id, pn, text('4'), g))).toEqual(['v6']);
    expect(retailerIdsIn(await say(id, pn, text('5'), g))).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'rate_limited' });
  });

  it('GIFT-BUDGET-TOOL-1: a refused recommendation tells the model to fall back to search_catalog for an explicit ask, and the prompt says an explicit ask never ends empty', async () => {
    const id = W(41);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'], v5: ['v6'], v7: ['v8'] };
    const g = graph();
    const ask = (seed: string) => rec({ basis: 'similar', productId: seed });
    const m = model([{ tools: [ask('v1')] }, { text: 'a' }, { tools: [ask('v3')] }, { text: 'b' }, { tools: [ask('v5')] }, { text: 'c' }, { tools: [ask('v7')] }, { text: 'd' }]);
    for (const n of ['1', '2', '3', '4']) await say(id, pn, text(n), g);
    expect(lastTool(m)).toMatchObject({ error: 'rate_limited', note: expect.stringContaining('search_catalog') });
    expect(m.calls[0]!.system).toContain('must NEVER end with nothing shown');
  });

  it('the ration is a 24 h window: sets older than a day no longer count, and an erased-looking stale row is pruned', async () => {
    const id = W(15);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'], v5: ['v6'], v7: ['v8'] };
    const g = graph();
    const ask = (seed: string) => rec({ basis: 'similar', productId: seed });
    const m = model([{ tools: [ask('v1')] }, { text: 'a' }, { tools: [ask('v3')] }, { text: 'b' }, { tools: [ask('v5')] }, { text: 'c' }, { tools: [ask('v7')] }, { text: 'd' }]);
    for (const t of ['1', '2', '3']) await say(id, pn, text(t), g);
    // age every stored set by 25 h: the customer is back under the cap
    await workspace(id).runDueTasks(Date.now());
    const { exec } = await import('./helpers/workspace');
    await exec(id, "UPDATE agent_state SET value = json_set(value, '$.at', json_extract(value, '$.at') - 90000000) WHERE key LIKE 'recs:%'");
    expect(retailerIdsIn(await say(id, pn, text('4'), g))).toEqual(['v8']);
    expect(lastTool(m)).not.toMatchObject({ error: 'rate_limited' });
  });

  it('one set per turn: a second call in the same turn is refused', async () => {
    const id = W(10);
    const pn = await shop(id);
    link.fake.recs = { v1: ['v2'], v3: ['v4'] };
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' }), rec({ basis: 'similar', productId: 'v3' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجات'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2']);
    const tools = m.calls[1]!.messages.filter((x) => x.role === 'tool').map((x) => (x as { content: string }).content);
    expect(tools[1]).toContain('already_recommended_this_turn');
  });

  it('after an order: seeds are the customer\'s own latest order, the key is derived from the chat', async () => {
    const id = W(11);
    const pn = await shop(id);
    const made = await link.fake.createOrderFromChat(id, { items: [{ variantId: 'v1', quantity: 1 }], buyer: { buyerKey: BUYER_KEY_1, phoneE164: `+${WA_1}`, name: null, locale: 'ar' }, paymentMethod: 'cod', idempotencyKey: 'idem-recs-1' });
    expect(made.ok).toBe(true);
    link.fake.recs.v1 = ['v5'];
    model([{ tools: [rec({ basis: 'after_order' })] }, { text: 'شكراً على طلبك، ده ممكن يعجبك 👇' }]);
    const out = await say(id, pn, text('شكرا على الاوردر'), graph());
    expect(retailerIdsIn(out)).toEqual(['v5']);
    expect(link.fake.lastCall('getRecommendations')).toEqual([id, expect.objectContaining({ mode: 'complement', buyerKey: BUYER_KEY_1, phoneE164: `+${WA_1}`, orderNumber: expect.any(String) })]);
    expect(link.fake.lastCall('listCustomerOrders')).toEqual([id, BUYER_KEY_1, 1, `+${WA_1}`]); // the latest-order lookup carries the sender's phone proof (WA-BRIDGE-BIND-1)
  });

  it('after an order for a customer with no orders: no_order, nothing sent', async () => {
    const id = W(12);
    const pn = await shop(id);
    const m = model([{ tools: [rec({ basis: 'after_order' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('thanks'), graph());
    expect(retailerIdsIn(out)).toEqual([]);
    expect(lastTool(m)).toMatchObject({ error: 'no_order' });
  });

  it('budget ("هدية تحت 105 جنيه"): searches the Store and keeps only in-stock items within the budget', async () => {
    const id = W(13);
    const pn = await shop(id);
    link.fake.stock.v1 = 0;
    model([{ tools: [rec({ basis: 'budget', query: 'item', maxPrice: 110 })] }, { text: 'دي في ميزانيتك' }]);
    const out = await say(id, pn, text('3ayez hadeya ta7t 110 geneh'), graph());
    expect(retailerIdsIn(out)).toEqual(['v2', 'v3']);
  });

  it('invalid arguments (similar without a product) come back as an error, not a crash', async () => {
    const id = W(14);
    const pn = await shop(id);
    const m = model([{ tools: [rec({ basis: 'similar' })] }, { text: 'تمام' }]);
    await say(id, pn, text('حاجة شبهه'), graph());
    expect(lastTool(m)).toMatchObject({ error: 'invalid_arguments' });
    expect(link.fake.count('getRecommendations')).toBe(0);
  });

  it('the budget cap is the Store\'s (1,000,000): the schema and the tool definition refuse more', () => {
    expect(MAX_BUDGET).toBe(1_000_000);
    expect(recommendArgs.safeParse({ basis: 'budget', query: 'x', maxPrice: 1_000_000 }).success).toBe(true);
    expect(recommendArgs.safeParse({ basis: 'budget', query: 'x', maxPrice: 1_000_001 }).success).toBe(false);
    expect((recommendToolDef.parameters as { properties: { maxPrice: { maximum: number } } }).properties.maxPrice.maximum).toBe(1_000_000);
  });

  it('a Store validation refusal reaches the model as invalid_arguments, a real outage stays store_unavailable', async () => {
    const id = W(20);
    const pn = await shop(id);
    link.fake.failNext.set('getRecommendations', 'invalid');
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    await say(id, pn, text('حاجة شبهه'), graph());
    expect(lastTool(m)).toEqual({ error: 'invalid_arguments' });
    // the refused call released its slot: nothing was sent, nothing is counted
    expect((await rows<{ n: number }>(id, "SELECT count(*) AS n FROM agent_state WHERE key LIKE 'recs:%'"))[0]!.n).toBe(0);
  });

  it('the ration is claimed atomically: two calls at once with ONE slot left send exactly one set (the turn lock is not what protects it)', async () => {
    const id = W(21);
    await shop(id);
    const { openChat } = await import('./helpers/workspace');
    for (let i = 1; i <= 4; i++) await openChat(id, '201005550001', { wamid: `wamid.race.${i}`, ts: Math.floor(Date.now() / 1000) + i });
    const mids = (await rows<{ id: number }>(id, "SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = '201005550001' ORDER BY m.id")).map((r) => r.id);
    expect(mids.length).toBeGreaterThanOrEqual(4);
    const sentSets = await runInDurableObject(workspace(id), async (_i, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      // two of the three slots are already used
      for (const m of mids.slice(0, 2)) sql.exec("INSERT INTO agent_state (key, value) VALUES (?, ?)", `recs:${m}`, JSON.stringify({ at: now - 1000, ids: [`old${m}`] }));
      const mk = (messageId: number) => ({ host: { sql, workspaceId: id, env: {} }, from: '201005550001', bridge: {}, availability: {}, locale: 'ar', cards: [], messageId }) as never;
      const lag = () => new Promise((r) => setTimeout(r, 20)); // the Store round trip: both calls are in flight together
      const deps = (pid: string) => ({
        search: async () => { await lag(); return { results: [{ id: pid, price: 10, inStock: true }] }; },
        show: async () => { await lag(); return { products: [{ id: pid }] }; },
      });
      const args = { basis: 'budget' as const, query: 'gift' };
      const [x, y] = await Promise.all([recommendProducts(mk(mids[2]!), args, deps('pA'), now), recommendProducts(mk(mids[3]!), args, deps('pB'), now)]);
      return [x, y].filter((r) => !(r as { error?: string }).error).length;
    });
    expect(sentSets).toBe(1);
    expect((await rows<{ n: number }>(id, "SELECT count(*) AS n FROM agent_state WHERE key LIKE 'recs:%'"))[0]!.n).toBe(3);
  });
});

/** Ruling WA-RECS-1: proactive suggestions default OFF for workspaces that existed at migration time, ON for new ones. */
describe('recommendProducts default (Ruling WA-RECS-1)', () => {
  const settingOf = async (id: string) => (await rows<{ value: string }>(id, "SELECT value FROM agent_state WHERE key = 'setting.recommendProducts'"))[0]?.value;

  const settingsOf = (id: string) => workspace(id).getAgentSettings();
  const bareWorkspace = async (id: string) => { await workspace(id).ingest({ phoneNumberId: 'pn', inbound: [{ wamid: `wamid.${id}`, from: '201000000001', ts: 1000, type: 'text', text: 'hi' }], statuses: [], receivedAt: 1 }); };

  it('a workspace created now reads ON, and migrate() wrote nothing into agent_state (a restore needs it empty)', async () => {
    const id = W(30);
    await bareWorkspace(id);
    expect((await settingsOf(id)).recommendProducts).toBe(true);
    expect(await rows(id, 'SELECT 1 FROM agent_state')).toEqual([]);
  });

  it('a workspace that existed before v47 (no marker, no row) reads OFF, and stays OFF when the merchant saves other settings', async () => {
    const id = W(31);
    await shop(id);
    await runInDurableObject(workspace(id), (_i, state) => {
      state.storage.sql.exec("DELETE FROM agent_state WHERE key = 'setting.recommendProducts'");
      state.storage.sql.exec('DELETE FROM workspace_meta');
      state.storage.sql.exec('DELETE FROM _migrations WHERE version >= 47');
      state.storage.sql.exec('DROP TABLE workspace_meta');
      state.storage.sql.exec('ALTER TABLE store_orders DROP COLUMN recs_outcome'); // v49 is re-run with v47 below
      state.storage.sql.exec('ALTER TABLE store_orders DROP COLUMN recs_at');
      migrate(state.storage); // an old workspace: done > 0, so no marker is written
    });
    expect(await rows(id, "SELECT 1 FROM workspace_meta WHERE key = 'recs_default_on'")).toEqual([]);
    expect((await settingsOf(id)).recommendProducts).toBe(false);
    expect((await workspace(id).setAgentSettings({ persona: 'x' })).ok).toBe(true);
    expect((await settingsOf(id)).recommendProducts).toBe(false);
  });

  it('a backup restores into a fresh workspace, and a pre-v47 backup (no recommendProducts row) restores OFF', async () => {
    const src = W(33), dst = W(34);
    await bareWorkspace(src); // no agent_state rows at all: what a pre-v47 backup carries
    await workspace(src).exportSnapshot('2026-11-17');
    const r = await workspace(dst).importSnapshot(`backups/${src}/2026-11-17/`);
    expect(r.ok).toBe(true);
    expect((await settingsOf(dst)).recommendProducts).toBe(false);
    // agent_state is exactly what the backup held: restore writes no hidden default row
    expect((await rows<{ n: number }>(dst, 'SELECT count(*) AS n FROM agent_state'))[0]!.n).toBe((await rows<{ n: number }>(src, 'SELECT count(*) AS n FROM agent_state'))[0]!.n);
  });

  it('a backup that HAS a recommendProducts row restores it as stored, with agent_state row counts equal', async () => {
    const src = W(36), dst = W(37);
    await shop(src); // saved settings: the row is explicit
    await workspace(src).exportSnapshot('2026-11-17');
    expect((await workspace(dst).importSnapshot(`backups/${src}/2026-11-17/`)).ok).toBe(true);
    expect((await settingsOf(dst)).recommendProducts).toBe(true);
    expect((await rows<{ n: number }>(dst, 'SELECT count(*) AS n FROM agent_state'))[0]!.n).toBe((await rows<{ n: number }>(src, 'SELECT count(*) AS n FROM agent_state'))[0]!.n);
  });

  it('a retried turn (same message id) that sends nothing keeps the set it already sent in the daily count', async () => {
    const id = W(35);
    await shop(id);
    const { openChat } = await import('./helpers/workspace');
    await openChat(id, '201005550002', { wamid: 'wamid.retry.1' });
    const mid = (await rows<{ id: number }>(id, "SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = '201005550002'"))[0]!.id;
    const after = await runInDurableObject(workspace(id), async (_i, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      sql.exec('INSERT INTO agent_state (key, value) VALUES (?, ?)', `recs:${mid}`, JSON.stringify({ at: now - 1000, ids: ['sent1'] }));
      const ctx = { host: { sql, workspaceId: id, env: {} }, from: '201005550002', bridge: {}, availability: {}, locale: 'ar', cards: [], messageId: mid } as never;
      const out = await recommendProducts(ctx, { basis: 'budget', query: 'x' }, { search: async () => ({ results: [] }), show: async () => ({}) }, now);
      return { out, row: sql.exec<{ value: string }>('SELECT value FROM agent_state WHERE key = ?', `recs:${mid}`).toArray()[0]?.value };
    });
    expect(after.out).toMatchObject({ error: 'nothing_to_recommend' });
    expect(JSON.parse(after.row!).ids).toEqual(['sent1']);
  });

  it('while OFF nothing is recommended (the tool is not offered and the bridge is never called); the merchant opt-in turns it on', async () => {
    const id = W(32);
    const pn = await shop(id);
    await runInDurableObject(workspace(id), (_i, state) => {
      state.storage.sql.exec("UPDATE agent_state SET value = '0' WHERE key = 'setting.recommendProducts'");
    });
    link.fake.recs.v1 = ['v2'];
    const m = model([{ tools: [rec({ basis: 'similar', productId: 'v1' })] }, { text: 'تمام' }]);
    const out = await say(id, pn, text('حاجة شبهه'), graph());
    expect(m.calls[0]!.tools.map((t) => t.name)).not.toContain('recommend_products');
    expect(retailerIdsIn(out)).toEqual([]);
    expect(link.fake.count('getRecommendations')).toBe(0);
    expect((await workspace(id).setAgentSettings({ recommendProducts: true })).ok).toBe(true);
    expect((await workspace(id).getAgentSettings()).recommendProducts).toBe(true);
  });
});
