import { describe, expect, it } from 'vitest';
import { CASES, type Group } from './eval/golden-cases';
import { grade, runCase, scoreboard, scriptedModel, type Verdict } from './eval/run';
import { useAgent, ScriptedProvider } from './helpers/agent';
import { useStoreLink } from './helpers/store-link';

// The golden eval, STRUCTURE mode (default CI, costs nothing): every conversation runs through the real agent turn (prompt, tools, Store, reply guard,
// handoff) with a SCRIPTED model that does what a correct model would, and the rubric must pass for all of them. That proves the cases, the rubric
// and the harness. It does NOT measure a model's judgement: that is the live run (test/chat-golden-live.test.ts, CHAT_EVAL_LIVE=1, docs/ai-agent.md).
const link = useStoreLink();
const agent = useAgent();
const env = { fake: undefined as never as typeof link.fake, agent: { model: undefined as never } };

const GROUPS: Group[] = ['gift', 'product', 'price', 'shipping', 'policy', 'tracking', 'complaint', 'offtopic', 'returning', 'voice', 'injection'];

describe('golden set: structure', () => {
  it('has 60-80 cases, unique ids, every group, and all three languages', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(CASES.length).toBeLessThanOrEqual(80);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const g of GROUPS) expect(CASES.filter((c) => c.group === g).length, g).toBeGreaterThanOrEqual(3);
    for (const l of ['ar', 'franco', 'en'] as const) expect(CASES.filter((c) => c.lang === l).length, l).toBeGreaterThanOrEqual(10);
  });
  it('every case has turns, a rubric that checks something, and scripted steps', () => {
    for (const c of CASES) {
      expect(c.turns.length, c.id).toBeGreaterThan(0);
      expect(c.scripted.length, c.id).toBeGreaterThanOrEqual(c.turns.length);
      expect(Object.keys(c.expect).length, c.id).toBeGreaterThan(0);
    }
  });
  it('the scenarios the audit named are all covered', () => {
    const has = (re: RegExp) => CASES.some((c) => re.test(c.turns.join(' ')));
    expect(has(/هدية|hadia|gift/)).toBe(true); // gift under budget
    expect(has(/مقاس|size/)).toBe(true); // size
    expect(has(/فين أوردري|where is my order/)).toBe(true); // tracking
    expect(CASES.some((c) => c.group === 'complaint' && c.expect.handoff === true)).toBe(true); // complaint -> handoff
    expect(CASES.some((c) => c.group === 'offtopic' && c.expect.noTools)).toBe(true); // off-topic
    expect(CASES.some((c) => c.group === 'price' && c.expect.avoid?.length)).toBe(true); // price with no data must not invent
    expect(CASES.some((c) => c.group === 'returning' && c.store === 'returning')).toBe(true); // returning customer
  });
});

describe('golden set: scripted model passes the rubric end to end', () => {
  it('all cases pass (this measures the harness, not a model)', async () => {
    const verdicts: Verdict[] = [];
    for (const [i, c] of CASES.entries()) verdicts.push(await runCase(c, { fake: link.fake, agent }, i, scriptedModel));
    const board = scoreboard(verdicts);
    expect(board.failures).toEqual([]);
    expect(board.passed).toBe(CASES.length);
  }, 600_000);
});

describe('golden set: the rubric fails what it must (negative controls)', () => {
  const byId = (id: string) => CASES.find((c) => c.id === id)!;
  const withModel = (id: string, steps: ConstructorParameters<typeof ScriptedProvider>[0], n: number) =>
    runCase(byId(id), { fake: link.fake, agent }, 900 + n, () => new ScriptedProvider(steps));

  it('a shipping fee the Store never declared is an invented fact', async () => {
    const v = await withModel('ship-ar-1', [{ text: 'الشحن للقاهرة 50 جنيه' }], 1);
    expect(v.failed).toContain('invented_fact');
  });
  it('a price for a product that does not exist is an invented fact', async () => {
    const v = await withModel('price-ar-3', [{ tools: [{ name: 'search_catalog', arguments: { query: 'ايفون' } }] }, { text: 'الايفون بـ 5000 جنيه' }], 2);
    expect(v.failed).toContain('invented_fact');
  });
  it('using the catalogue tool on an off-topic question fails', async () => {
    const v = await withModel('off-ar-1', [{ tools: [{ name: 'search_catalog', arguments: { query: 'معادلة' } }] }, { text: 'مفيش' }], 3);
    expect(v.failed).toContain('used_tools_off_topic');
  });
  it('answering a complaint instead of handing over fails', async () => {
    const v = await withModel('complaint-ar-1', [{ text: 'معلش حصل خير' }], 4);
    expect(v.failed).toContain('no_handoff');
  });
  it('an English reply to an Arabic shopper fails the script check; ignoring the budget fails the budget check', async () => {
    const v = await withModel('gift-ar-1', [{ tools: [{ name: 'search_catalog', arguments: { query: 'gift' } }] }, { text: 'Here are some ideas for you' }], 5);
    expect(v.failed).toEqual(expect.arrayContaining(['wrong_script', 'budget_not_used']));
  });
  it('GIFT-BUDGET-TOOL-1: a card over the budget fails, a gave-up ask fails, and recommend_products with the ceiling passes', async () => {
    const over = await withModel('gift-ar-1', [{ tools: [{ name: 'search_catalog', arguments: { query: 'هدية', maxPrice: 500 } }] }, { tools: [{ name: 'show_products', arguments: { ids: ['v6'] } }] }, { text: 'اختيار حلو' }], 6); // v6 costs 550
    expect(over.failed).toContain('over_budget_shown');
    const gaveUp = await withModel('gift-ar-1', [{ tools: [{ name: 'search_catalog', arguments: { query: 'هدية', maxPrice: 500 } }] }, { text: 'مفيش حاجة مناسبة' }], 7);
    expect(gaveUp.failed).toContain('gave_up_on_explicit_ask');
    const viaRec = await withModel('gift-ar-1', [{ tools: [{ name: 'recommend_products', arguments: { basis: 'budget', query: 'هدية للسيدات', maxPrice: 500 } }] }, { text: 'اخترتلك دول في ميزانيتك' }], 8);
    expect(viaRec.failed).toEqual([]);
  });
  it('GIFT-BUDGET-TOOL-1: at the ration limit, stopping after the refused recommend_products fails; falling back to search_catalog passes', async () => {
    const stopped = await withModel('gift-ration-ar-1', [{ tools: [{ name: 'recommend_products', arguments: { basis: 'budget', query: 'هدية للسيدات', maxPrice: 500 } }] }, { text: 'مفيش اقتراحات دلوقتي' }], 9);
    expect(stopped.failed).toEqual(expect.arrayContaining(['missing_tool:search_catalog', 'gave_up_on_explicit_ask']));
  });
  it('grade() on a clean run is empty', () => {
    expect(grade(byId('off-ar-2'), { replies: ['أنا مساعد المتجر وبرد على أسئلة المنتجات والطلبات بس.'], outcome: 'reply', tools: [] })).toEqual([]);
  });
});
