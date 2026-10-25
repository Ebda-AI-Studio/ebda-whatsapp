import { describe, expect, it } from 'vitest';
import { LlmError } from '../src/core/ai/provider';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, sendCount, sentOf, text } from './helpers/agent-chat';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { graphStub } from './helpers/api';
import { WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000054${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0], byo = false) => (agent.model = new ScriptedProvider(steps, byo)) as ScriptedProvider;
const grant = (ws: string, credits = 10) => workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits });
let seq = 0;
const tags = async (ws: string) => (await rows<{ tag: string }>(ws, 'SELECT tag FROM conversation_tags')).map((r) => r.tag);
const balance = async (ws: string) => (await workspace(ws).aiCredits()).balance;

describe('handoff', () => {
  it.each([
    ['عايز اكلم حد', 'ar'],
    ['ممكن اتكلم مع موظف؟', 'ar'],
    ['أبغى أكلم شخص', 'ar'],
    ['خدمة العملاء لو سمحت', 'ar'],
    ['I want to talk to a human', 'en'],
    ['can I speak to someone please', 'en'],
    ['real person?', 'en'],
  ])('the words "%s" send the customer to a person without calling the model (and cost no credit)', async (words, lang) => {
    const ws = W(1 + seq++);
    const pn = await agentWorkspace(ws, { language: 'auto' });
    await grant(ws);
    const m = model([]);
    const out = await say(ws, pn, text(words), stubGraph());
    expect(m.callCount).toBe(0);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck[lang as 'ar' | 'en']]);
    expect(await tags(ws)).toEqual(['needs_human']);
    expect(await balance(ws)).toBe(10);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'asked' });
  });

  it('ordinary words do not trigger it', async () => {
    const ws = W(20);
    const pn = await agentWorkspace(ws);
    await grant(ws);
    model([{ text: 'عندنا ايفونات' }]);
    const out = await say(ws, pn, text('عندكم موبايلات بشرية؟ لا قصدي ايفون'), stubGraph());
    expect(out.map((s) => s.text)).toEqual(['عندنا ايفونات']);
    expect(await tags(ws)).toEqual([]);
  });

  it('the model can hand over too (handoff_to_human); the bot is then silent for handoffMinutes, then resumes and clears the tag', async () => {
    const ws = W(31);
    const pn = await agentWorkspace(ws, { handoffMinutes: 45 });
    await grant(ws);
    const m = model([{ tools: [{ name: 'handoff_to_human' }] }, { text: 'رجعت' }]);
    const g = stubGraph();
    expect((await say(ws, pn, text('عندي شكوى في الطلب'), g)).map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    const h = (await rows<{ started_at: number; until_at: number; reason: string }>(ws, 'SELECT * FROM agent_handoffs'))[0]!;
    expect(h.until_at - h.started_at).toBe(45 * 60_000);
    expect(h.reason).toBe('model');
    expect(await tags(ws)).toEqual(['needs_human']);
    // silent: no model call, no send, however many messages come
    const before = sendCount(g);
    expect(await say(ws, pn, text('حد هنا؟'), g)).toEqual([]);
    expect(await say(ws, pn, text('???'), g)).toEqual([]);
    expect(m.callCount).toBe(1);
    expect(sendCount(g)).toBe(before);
    // the window passes
    await exec(ws, 'UPDATE agent_handoffs SET until_at = ?', Date.now() - 1);
    expect((await say(ws, pn, text('مرحبا تاني'), g)).map((s) => s.text)).toEqual(['رجعت']);
    expect(await tags(ws)).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM agent_handoffs')).toEqual([]);
  });

  it('a staff reply clears the badge and keeps the bot out for a fresh window from that reply', async () => {
    const ws = storeId(5401);
    const api = await apiFor(ws);
    await agentWorkspace(ws, { handoffMinutes: 60 });
    await grant(ws);
    const m = model([{ text: 'x' }]);
    const g = graphStub();
    await say(ws, api.phoneNumberId, text('عايز اكلم موظف'), g);
    expect(await tags(ws)).toEqual(['needs_human']);
    const convId = (await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id;
    await exec(ws, 'UPDATE agent_handoffs SET until_at = ?', Date.now() + 5 * 60_000); // 5 minutes left
    const res = await api.call('POST', `/conversations/${convId}/messages`, { type: 'text', clientId: crypto.randomUUID(), text: 'أنا معاك' });
    expect(res.status).toBe(202);
    expect((await res.json() as { author?: string }).author).toBe('staff');
    expect(await tags(ws)).toEqual([]);
    const until = (await rows<{ until_at: number }>(ws, 'SELECT until_at FROM agent_handoffs'))[0]!.until_at;
    expect(until).toBeGreaterThan(Date.now() + 59 * 60_000);
    expect(await say(ws, api.phoneNumberId, text('تمام شكراً'), g)).toEqual([]);
    expect(m.callCount).toBe(0);
  });

  it('a staff reply with no open handoff silences the bot for the handoff window: the customer answers and gets no AI reply', async () => {
    const ws = storeId(5402);
    const api = await apiFor(ws);
    await agentWorkspace(ws, { handoffMinutes: 30 });
    await grant(ws);
    const m = model([{ text: 'أهلاً' }, { text: 'لا يجب أن يُرسل' }]);
    const g = graphStub();
    await say(ws, api.phoneNumberId, text('hi'), g);
    expect(m.callCount).toBe(1);
    const convId = (await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id;
    await api.call('POST', `/conversations/${convId}/messages`, { type: 'text', clientId: crypto.randomUUID(), text: 'أنا معاك' });
    const h = (await rows<{ until_at: number; reason: string }>(ws, 'SELECT until_at, reason FROM agent_handoffs'))[0]!;
    expect(h.until_at).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(h.reason).toBe('staff');
    expect(await tags(ws)).toEqual([]); // someone is already on it: no badge
    expect(await say(ws, api.phoneNumberId, text('تمام شكراً'), g)).toEqual([]);
    expect(m.callCount).toBe(1);
  });

  it('assigning a conversation to a person silences the bot too', async () => {
    const ws = storeId(5403);
    const api = await apiFor(ws);
    await agentWorkspace(ws, { handoffMinutes: 30 });
    await grant(ws);
    const m = model([{ text: 'أهلاً' }, { text: 'لا يجب أن يُرسل' }]);
    const g = graphStub();
    await say(ws, api.phoneNumberId, text('hi'), g);
    const convId = (await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id;
    expect((await workspace(ws).assign(convId, 'u-1', 'u-1')).ok).toBe(true);
    expect(await say(ws, api.phoneNumberId, text('حد هنا؟'), g)).toEqual([]);
    expect(m.callCount).toBe(1);
    // clearing the assignee does not open a window by itself
    expect((await workspace(ws).assign(convId, null, 'u-1')).ok).toBe(true);
  });

  it('tells open inboxes: the realtime log carries a conversation.updated with the tag', async () => {
    const ws = W(32);
    const pn = await agentWorkspace(ws);
    await say(ws, pn, text('كلمني موظف'), stubGraph());
    const events = (await rows<{ payload: string }>(ws, 'SELECT payload FROM events ORDER BY seq')).map((r) => JSON.parse(r.payload)) as { type: string; conversation?: { tags: string[] } }[];
    expect(events.some((e) => e.type === 'conversation.updated' && e.conversation?.tags.includes('needs_human'))).toBe(true);
  });

  it('applies to the ordering bot too, and mid-order words still reach a person', async () => {
    const ws = W(33);
    const pn = await agentWorkspace(ws);
    await grant(ws);
    model([]);
    const g = stubGraph();
    await say(ws, pn, text('menu'), g); // opens the catalog (ordering)
    expect((await say(ws, pn, text('عايز اكلم حد'), g)).map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect(await say(ws, pn, text('menu'), g)).toEqual([]); // silent for everyone while a person has it
  });

  it('erasing the customer removes the handoff with them', async () => {
    const ws = W(34);
    const pn = await agentWorkspace(ws);
    await say(ws, pn, text('عايز اكلم حد'), stubGraph());
    await workspace(ws).eraseContact(WA_1);
    expect(await rows(ws, 'SELECT 1 FROM agent_handoffs')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM agent_turns')).toEqual([]);
  });
});

describe('AI credits', () => {
  it('at zero credits the agent stops and hands over; the model is never called', async () => {
    const ws = W(40);
    const pn = await agentWorkspace(ws);
    const m = model([{ text: 'x' }]);
    const out = await say(ws, pn, text('عندكم ايه؟'), stubGraph());
    expect(m.callCount).toBe(0);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'no_credits' });
    expect(await tags(ws)).toEqual(['needs_human']);
  });

  it('a reply costs exactly one credit, recorded under ai:<messageId>; the last credit is spent, the next customer is handed over', async () => {
    const ws = W(41);
    const pn = await agentWorkspace(ws);
    await grant(ws, 1);
    model([{ text: 'أهلاً' }]);
    const g = stubGraph();
    expect((await say(ws, pn, text('hi'), g)).map((s) => s.text)).toEqual(['أهلاً']);
    expect(await balance(ws)).toBe(0);
    const row = (await rows<{ ref: string; amount: number; kind: string }>(ws, "SELECT ref, amount, kind FROM credit_ledger WHERE kind = 'ai_charge'"))[0]!;
    expect(row).toMatchObject({ amount: -1, ref: expect.stringMatching(/^ai:\d+$/) });
    expect((await say(ws, pn, text('تاني', '201002222222'), g)).map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
  });

  it('a turn with tool rounds is still one credit', async () => {
    const ws = W(42);
    const pn = await agentWorkspace(ws);
    await grant(ws, 5);
    model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item' } }] }, { tools: [{ name: 'search_catalog', arguments: { query: 'item 2' } }] }, { text: 'لقيت' }]);
    await say(ws, pn, text('عايز'), stubGraph());
    expect(await balance(ws)).toBe(4);
  });

  it('a model that failed is not charged and the hold is given back', async () => {
    const ws = W(43);
    const pn = await agentWorkspace(ws);
    await grant(ws, 1);
    model([{ fail: new LlmError('http', false, 500) }]);
    await say(ws, pn, text('hi'), stubGraph());
    expect(await balance(ws)).toBe(1);
    expect((await workspace(ws).aiCredits()).available).toBe(1);
    expect(await rows(ws, 'SELECT state FROM credit_holds')).toEqual([{ state: 'released' }]);
  });

  it('a workspace with its own model key is never debited, even at zero credits', async () => {
    const ws = W(44);
    const pn = await agentWorkspace(ws);
    const m = model([{ text: 'من نموذجي الخاص' }], true);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(out.map((s) => s.text)).toEqual(['من نموذجي الخاص']);
    expect(m.callCount).toBe(1);
    expect(await rows(ws, 'SELECT 1 FROM credit_ledger')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM credit_holds')).toEqual([]);
  });

  it('two customers writing at once with one credit left: one answer, one handoff, never a negative balance', async () => {
    const ws = W(45);
    const pn = await agentWorkspace(ws);
    await grant(ws, 1);
    const m = model([{ text: 'أنا الأول', delayMs: 60 }, { text: 'أنا التاني', delayMs: 60 }]);
    const g = stubGraph();
    await Promise.all([say(ws, pn, text('hi', '201001111111'), g), say(ws, pn, text('hi', '201002222222'), g)]);
    // Count from the shared stub once: each say() returns every send since it started, so overlapping calls would count the other's reply twice.
    const all = sentOf(g).filter((s) => ['201001111111', '201002222222'].includes(s.body.to)).map((s) => s.text);
    expect(m.callCount).toBe(1);
    expect(all.filter((t) => t === EBDA_AGENT_COPY.t.handoffAck.ar).length).toBe(1);
    expect(all.filter((t) => t?.startsWith('أنا'))).toHaveLength(1);
    expect(await balance(ws)).toBe(0);
    expect((await rows<{ n: number }>(ws, 'SELECT min(balance_after) AS n FROM credit_ledger'))[0]!.n).toBeGreaterThanOrEqual(0);
  });

  it('heartbeat: a hold that was about to lapse is extended at each round of the same turn', async () => {
    const ws = W(46);
    const pn = await agentWorkspace(ws);
    await grant(ws, 1);
    let seen = 0;
    const base = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item' } }] }, { text: 'تمام' }]);
    const orig = base.complete.bind(base);
    let n = 0;
    base.complete = async (r) => {
      n++;
      if (n === 1) await exec(ws, 'UPDATE credit_holds SET expires_at = ?', Date.now() + 50); // nearly lapsed
      if (n === 2) seen = (await rows<{ expires_at: number }>(ws, 'SELECT expires_at FROM credit_holds'))[0]!.expires_at;
      return orig(r);
    };
    await say(ws, pn, text('hi'), stubGraph());
    expect(seen).toBeGreaterThan(Date.now() + 60_000);
    expect(await balance(ws)).toBe(0);
  });

  it('a hold that lapsed and whose credit was spent elsewhere is not charged: the answer goes out, the balance stays >= 0', async () => {
    const ws = W(47);
    const pn = await agentWorkspace(ws);
    await grant(ws, 1);
    const base = model([{ text: 'جاوبت' }]);
    const orig = base.complete.bind(base);
    base.complete = async (r) => {
      // while the model "thinks": the hold lapses and another call spends the only credit
      await exec(ws, "UPDATE credit_holds SET state = 'expired', expires_at = 1");
      await workspace(ws).postAiCredits({ kind: 'adjustment', amount: -1, ref: 'adj:other', actor: 'u', note: 'other call' });
      return orig(r);
    };
    const log: string[] = [];
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    const out = await say(ws, pn, text('hi'), stubGraph());
    spy.mockRestore();
    expect(out.map((s) => s.text)).toEqual(['جاوبت']);
    expect(await balance(ws)).toBe(0);
    expect(await rows(ws, "SELECT 1 FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([]);
    expect(log.join(' ')).toContain('ai_overdraw_refused');
  });

  it('the settings answer shows the credits available', async () => {
    const ws = storeId(5410);
    const api = await apiFor(ws);
    await grant(ws, 7);
    expect(await (await api.call('GET', '/agent')).json()).toMatchObject({ credits: 7 });
  });
});
