/**
 * Agent quality eval, ported from the old product's intent eval (botIntentEval): its intents become the tool a customer's
 * utterance must lead to, and its five output-shape checks (valid intent, required field present, a confident answer has a
 * reply, no leaked JSON, bounded) become guards on what the model may emit. The model is a scripted fake, so this measures
 * the harness (routing, validation, guards, handoff, credits), NOT the live model's judgement: a live golden run needs a
 * model call and is not part of the suite.
 */
import { describe, expect, it } from 'vitest';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { ScriptedProvider, type Step, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000056${String(n).padStart(2, '0')}`;
const HANDOFF = EBDA_AGENT_COPY.t.handoffAck;

type Expect =
  | { kind: 'reply'; text: string }
  | { kind: 'handoff'; lang?: 'ar' | 'en' }
  | { kind: 'catalog' } // the ordering menu opened (list sent)
  | { kind: 'tool_result'; contains: string; then: string };
type Case = { id: string; from: string; steps: Step[]; expect: Expect; calls: number; tools?: string[]; language?: 'ar' | 'en' | 'auto' };

const search = (q: string): Step => ({ tools: [{ name: 'search_catalog', arguments: { query: q } }] });
const CASES: Case[] = [
  // golden: an utterance leads to the right tool and a clean reply
  { id: 'browse-products', from: 'عندكم ايه؟', steps: [search('منتجات'), { text: 'عندنا Item 1 و Item 2' }], expect: { kind: 'reply', text: 'عندنا Item 1 و Item 2' }, calls: 2, tools: ['search_catalog'] },
  { id: 'search-by-word', from: 'عايز محفظة', steps: [search('محفظة'), { text: 'مفيش محافظ دلوقتي' }], expect: { kind: 'reply', text: 'مفيش محافظ دلوقتي' }, calls: 2, tools: ['search_catalog'] },
  { id: 'search-english', from: 'do you have item 3', steps: [search('item 3'), { text: 'Yes, Item 3 is 110 EGP' }], expect: { kind: 'reply', text: 'Yes, Item 3 is 110 EGP' }, calls: 2, tools: ['search_catalog'], language: 'auto' },
  { id: 'pick-product', from: 'هاخد Item 2', steps: [{ tools: [{ name: 'start_order' }] }], expect: { kind: 'catalog' }, calls: 1, tools: ['start_order'] },
  { id: 'confirm-order', from: 'تمام عايز اكمل الطلب', steps: [{ tools: [{ name: 'start_order' }] }], expect: { kind: 'catalog' }, calls: 1, tools: ['start_order'] },
  { id: 'add-more-items', from: 'ضيفلي حاجة تانية', steps: [{ tools: [{ name: 'start_order' }] }], expect: { kind: 'catalog' }, calls: 1, tools: ['start_order'] },
  { id: 'order-status', from: 'فين طلبي؟', steps: [{ tools: [{ name: 'order_status' }] }, { text: 'مفيش طلبات على رقمك' }], expect: { kind: 'reply', text: 'مفيش طلبات على رقمك' }, calls: 2, tools: ['order_status'] },
  { id: 'repeat-last-order', from: 'نفس الطلب اللي فات', steps: [{ tools: [{ name: 'order_status' }] }, { text: 'آخر طلب ليك كان 1001، تحب نكرره؟' }], expect: { kind: 'reply', text: 'آخر طلب ليك كان 1001، تحب نكرره؟' }, calls: 2, tools: ['order_status'] },
  { id: 'resend-link', from: 'ابعتلي اللينك تاني', steps: [{ tools: [{ name: 'order_status', arguments: { orderNumber: '1001' } }] }, { text: 'هتلاقي اللينك في رسالة الطلب' }], expect: { kind: 'reply', text: 'هتلاقي اللينك في رسالة الطلب' }, calls: 2, tools: ['order_status'] },
  { id: 'ask-question', from: 'بتشحنوا للإسكندرية؟', steps: [{ text: 'أيوه بنشحن لكل المحافظات' }], expect: { kind: 'reply', text: 'أيوه بنشحن لكل المحافظات' }, calls: 1 },
  { id: 'unclear-asks-back', from: 'ممم', steps: [{ text: 'ممكن توضحلي تقصد إيه؟' }], expect: { kind: 'reply', text: 'ممكن توضحلي تقصد إيه؟' }, calls: 1 },
  { id: 'two-tools-one-round', from: 'عايز Item 4 وفين طلبي', steps: [{ tools: [{ name: 'search_catalog', arguments: { query: 'item 4' } }, { name: 'order_status' }] }, { text: 'Item 4 موجود وطلبك لسه ما اتحركش' }], expect: { kind: 'reply', text: 'Item 4 موجود وطلبك لسه ما اتحركش' }, calls: 2, tools: ['search_catalog', 'order_status'] },
  // handoff by words: no model call at all
  ...[['عايز اكلم حد', 'ar'], ['اتكلم مع موظف', 'ar'], ['ابغى اكلم شخص', 'ar'], ['محتاج خدمة العملاء', 'ar'], ['talk to a human', 'en'], ['speak to someone', 'en'], ['I need a real person', 'en'], ['customer service please', 'en']].map(([w, lang], i) => (
    { id: `handoff-words-${i}`, from: w!, steps: [], expect: { kind: 'handoff', lang: lang as 'ar' | 'en' } as Expect, calls: 0, language: 'auto' as const })),
  // the model decides to hand over
  { id: 'model-handoff', from: 'عندي مشكلة في الدفع واتخصمت مرتين', steps: [{ tools: [{ name: 'handoff_to_human' }] }], expect: { kind: 'handoff' }, calls: 1, tools: ['handoff_to_human'] },
  // known failures (ported): malformed output never reaches the customer
  { id: 'invalid-tool-name', from: 'عايز حاجة', steps: [{ tools: [{ name: 'buy_now' }] }, { text: 'مش قادر اعمل كده، ممكن اساعدك بحاجة تانية؟' }], expect: { kind: 'tool_result', contains: 'unknown_tool', then: 'مش قادر اعمل كده، ممكن اساعدك بحاجة تانية؟' }, calls: 2 },
  { id: 'search-missing-query', from: 'ابحثلي', steps: [{ tools: [{ name: 'search_catalog', arguments: {} }] }, { text: 'تدور على ايه بالظبط؟' }], expect: { kind: 'tool_result', contains: 'invalid_arguments', then: 'تدور على ايه بالظبط؟' }, calls: 2 },
  { id: 'unparseable-arguments', from: 'ابحثلي', steps: [{ tools: [{ name: 'search_catalog', arguments: { __unparseable: true } }] }, { text: 'ممكن تعيد سؤالك؟' }], expect: { kind: 'tool_result', contains: 'invalid_arguments', then: 'ممكن تعيد سؤالك؟' }, calls: 2 },
  { id: 'confident-but-empty-reply', from: 'مرحبا', steps: [{ text: '' }], expect: { kind: 'handoff' }, calls: 1 },
  { id: 'reply-json-leak', from: 'مرحبا', steps: [{ text: '{"intent":"confirm_order","reply":"ok"}' }], expect: { kind: 'handoff' }, calls: 1 },
  { id: 'reply-tool-markup-leak', from: 'مرحبا', steps: [{ text: '<tool_call>{"name":"x"}</tool_call>' }], expect: { kind: 'handoff' }, calls: 1 },
  { id: 'thinking-only', from: 'مرحبا', steps: [{ text: '<think>he wants a discount</think>' }], expect: { kind: 'handoff' }, calls: 1 },
  { id: 'thinking-removed-from-good-reply', from: 'مرحبا', steps: [{ text: '<think>say hi</think>أهلاً بيك' }], expect: { kind: 'reply', text: 'أهلاً بيك' }, calls: 1 },
  { id: 'tool-loop-bounded', from: 'عايز', steps: [search('a'), search('b'), search('c'), search('d')], expect: { kind: 'handoff' }, calls: 4 },
];

describe('agent eval (scripted model)', () => {
  const results: { id: string; pass: boolean }[] = [];

  CASES.forEach((c, i) => {
    it(c.id, async () => {
      const ws = W(i);
      const pn = await agentWorkspace(ws, { ...(c.language ? { language: c.language } : {}) });
      await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'eval', credits: 5 });
      const model = (agent.model = new ScriptedProvider(c.steps)) as ScriptedProvider;
      const out = await say(ws, pn, text(c.from), stubGraph());
      let pass = model.callCount === c.calls;
      const e = c.expect;
      if (e.kind === 'reply') pass &&= out.length === 1 && out[0]!.text === e.text;
      else if (e.kind === 'handoff') pass &&= out.length === 1 && out[0]!.text === HANDOFF[e.lang ?? 'ar'];
      else if (e.kind === 'catalog') pass &&= out.at(-1)?.kind === 'list';
      else pass &&= out.length === 1 && out[0]!.text === e.then && model.calls[1]!.messages.some((m) => m.role === 'tool' && m.content.includes(e.contains));
      if (c.tools) pass &&= JSON.stringify(model.emitted) === JSON.stringify(c.tools);
      // credits: one per turn that called the model and was not a handoff by words
      const credits = (await workspace(ws).aiCredits()).balance;
      pass &&= credits === (c.calls > 0 && !(e.kind === 'handoff' && c.calls === 0) ? 4 : 5);
      results.push({ id: c.id, pass });
      expect(pass, c.id).toBe(true);
    });
  });

  it('pass rate', () => {
    const rate = results.filter((r) => r.pass).length / CASES.length;
    console.log(`AGENT_EVAL pass rate: ${results.filter((r) => r.pass).length}/${CASES.length} (${(rate * 100).toFixed(1)}%)`);
    expect(results.length).toBe(CASES.length);
    expect(rate).toBe(1);
  });
});
