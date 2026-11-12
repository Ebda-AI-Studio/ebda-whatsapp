import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../src/core/ai/provider';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { configureStoreLink } from '../src/core/store-link';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, audio, say, sendCount, sentOf, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { listReply } from './helpers/payload';
import { BUYER_KEY_1, WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

const link = useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000052${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
/** The agent on, with plenty of credits (credit rules have their own tests). */
const agentWs = async (ws: string, settings: Record<string, unknown> = {}) => {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};
const authors = (ws: string) => rows<{ author: string | null; body: string; idempotency_key: string }>(ws, "SELECT author, body, idempotency_key FROM messages WHERE direction = 'out' ORDER BY id");

describe('the agent answers', () => {
  it('replies to a text inside the window, marked as the agent, with persona, tools and history in the prompt', async () => {
    const ws = W(1);
    const pn = await agentWs(ws, { persona: 'انت مساعد متجر الورد' });
    const m = model([{ text: 'أهلاً بيك! أقدر أساعدك إزاي؟' }]);
    const g = stubGraph();
    const out = await say(ws, pn, text('مساء الخير'), g);
    expect(out.map((s) => s.text)).toEqual(['أهلاً بيك! أقدر أساعدك إزاي؟']);
    expect(await authors(ws)).toEqual([{ author: 'agent', body: 'أهلاً بيك! أقدر أساعدك إزاي؟', idempotency_key: expect.stringMatching(/^agent:\d+:0$/) }]);
    const req = m.calls[0]!;
    expect(req.system).toContain('انت مساعد متجر الورد');
    expect(req.system).toContain('search_catalog');
    expect(req.messages).toEqual([{ role: 'user', content: '<customer_message>مساء الخير</customer_message>' }]);
    expect(req.tools.map((t) => t.name)).toEqual(['search_catalog', 'order_status', 'start_order', 'handoff_to_human']);
    expect(req.maxTokens).toBeGreaterThan(0);
  });

  it('the message DTO carries author for the inbox', async () => {
    const ws = W(2);
    const pn = await agentWs(ws);
    model([{ text: 'تمام' }]);
    await say(ws, pn, text('hi'), stubGraph());
    const msgs = await workspace(ws).getMessages((await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id, undefined, 10);
    expect(msgs!.items.map((m) => m.author ?? null)).toEqual([null, 'agent']);
  });

  it('keeps the previous turns as context', async () => {
    const ws = W(3);
    const pn = await agentWs(ws);
    const m = model([{ text: 'عندنا ورد بلدي' }, { text: 'سعره 100' }]);
    const g = stubGraph();
    await say(ws, pn, text('عندكم ورد؟'), g);
    await say(ws, pn, text('بكام؟'), g);
    expect(m.calls[1]!.messages).toEqual([{ role: 'user', content: '<customer_message>عندكم ورد؟</customer_message>' }, { role: 'assistant', content: 'عندنا ورد بلدي' }, { role: 'user', content: '<customer_message>بكام؟</customer_message>' }]);
  });
});

describe('tools', () => {
  it('search_catalog reads the Store now (fresh price and stock) and the model sees it', async () => {
    const ws = W(4);
    const pn = await agentWs(ws);
    link.fake.stock['v3'] = 0;
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item 3' } }] }, { text: 'Item 3 خلص للأسف' }]);
    const out = await say(ws, pn, text('عايز item 3'), stubGraph());
    expect(out.map((s) => s.text)).toEqual(['Item 3 خلص للأسف']);
    const tool = m.calls[1]!.messages.at(-1)!;
    expect(tool).toMatchObject({ role: 'tool', name: 'search_catalog' });
    const parsed = JSON.parse((tool as { content: string }).content) as { results: { id: string; inStock: boolean; price: number }[] };
    expect(parsed.results[0]).toMatchObject({ id: 'v3', inStock: false, price: 110 });
    expect(link.fake.count('listCatalog')).toBeGreaterThan(0);
  });

  it('order_status asks the Store with the customer key derived from the chat, never from the model', async () => {
    const ws = W(5);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'order_status', arguments: { orderNumber: '1001', buyerKey: 'x'.repeat(64), phone: '+201111111111' } }] }, { text: 'طلبك في الطريق' }]);
    await say(ws, pn, text('فين طلبي 1001'), stubGraph());
    expect(link.fake.lastCall('getOrderStatus')).toEqual([ws, '1001', BUYER_KEY_1]);
    expect((m.calls[1]!.messages.at(-1) as { content: string }).content).toContain('order_not_found');
  });

  it('invalid arguments and unknown tools come back to the model as errors, not as crashes', async () => {
    const ws = W(6);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'search_catalog', arguments: {} }, { name: 'delete_everything', arguments: {} }] }, { text: 'مش فاهم قصدك، ممكن توضح؟' }]);
    const out = await say(ws, pn, text('???'), stubGraph());
    expect(out.length).toBe(1);
    const tools = m.calls[1]!.messages.filter((x) => x.role === 'tool').map((x) => (x as { content: string }).content);
    expect(tools).toEqual(['{"error":"invalid_arguments"}', '{"error":"unknown_tool"}']);
  });

  it('at most 3 tool rounds: the 4th call is offered no tools; still wanting tools means a handoff', async () => {
    const ws = W(7);
    const pn = await agentWs(ws);
    const again = { tools: [{ name: 'search_catalog', arguments: { query: 'item' } }] };
    const m = model([again, again, again, again]);
    const out = await say(ws, pn, text('عايز حاجة'), stubGraph());
    expect(m.callCount).toBe(4);
    expect(m.calls.map((c) => c.tools.length > 0)).toEqual([true, true, true, false]);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect((await rows(ws, "SELECT outcome FROM agent_turns"))[0]).toEqual({ outcome: 'handoff:no_answer' });
  });

  it('start_order hands over to the ordering state machine: the catalog opens, the model is not asked again', async () => {
    const ws = W(8);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'start_order' }] }]);
    const out = await say(ws, pn, text('عايز اطلب'), stubGraph());
    expect(m.callCount).toBe(1);
    expect(out[0]!.kind).toBe('text');
    expect(out.at(-1)!.kind).toBe('list');
    expect((await rows<{ state: string }>(ws, 'SELECT state FROM bot_sessions'))[0]!.state).toBe('browsing');
    expect((await authors(ws)).every((a) => a.author === 'bot')).toBe(true);
  });
});

describe('one router: ordering bot or agent, never both', () => {
  it('a customer mid-order stays with the ordering bot; the list tap, a stale session and idle text go as expected', async () => {
    const ws = W(9);
    const pn = await agentWs(ws);
    const m = model([{ text: 'أهلاً' }, { text: 'ردّ تاني' }]);
    const g = stubGraph();
    await say(ws, pn, text('السلام عليكم'), g); // idle -> agent
    expect(m.callCount).toBe(1);
    await say(ws, pn, text('menu'), g); // ordering keyword -> ordering bot opens the catalog
    expect(m.callCount).toBe(1);
    const tap = await say(ws, pn, listReply('wamid.tap.1', 'v:v2', 'x'), g); // tap -> ordering
    expect(tap.length).toBeGreaterThan(0);
    expect(m.callCount).toBe(1);
    const free = await say(ws, pn, text('كام سعر الشحن؟'), g); // mid-order free text -> still ordering ("use the buttons")
    expect(m.callCount).toBe(1);
    expect(free.length).toBeGreaterThan(0);
    // the session goes stale (a forgotten browse): the agent answers again
    await exec(ws, 'UPDATE bot_sessions SET updated_at = updated_at - ?', 31 * 60_000);
    await say(ws, pn, text('كام سعر الشحن؟'), g);
    expect(m.callCount).toBe(2);
  });

  it('agent off: only the ordering bot (as in Phase 4); agent on with no Store bound: the agent alone', async () => {
    const ws = W(10);
    const pn = await agentWs(ws, { enabled: false });
    const m = model([{ text: 'x' }]);
    const g = stubGraph();
    const out = await say(ws, pn, text('hi'), g);
    expect(m.callCount).toBe(0);
    expect(out.at(-1)!.kind).toBe('list');

    const ws2 = W(11);
    const pn2 = await agentWs(ws2);
    const previous = configureStoreLink({ bridge: () => null });
    try {
      const m2 = model([{ text: 'أهلاً بيك' }]);
      const out2 = await say(ws2, pn2, text('hi'), g);
      expect(m2.callCount).toBe(1);
      expect(m2.calls[0]!.tools.map((t) => t.name)).toEqual(['handoff_to_human']);
      expect(out2.map((s) => s.text)).toEqual(['أهلاً بيك']);
    } finally {
      configureStoreLink(previous);
    }
  });

  it('with the agent on, the generic auto reply is suppressed', async () => {
    const ws = W(12);
    const pn = await agentWs(ws);
    model([{ text: 'رد واحد' }]);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(out.map((s) => s.text)).toEqual(['رد واحد']);
  });
});

describe('rules shared with the ordering bot', () => {
  it('answers inside the 24 h window only', async () => {
    const ws = W(13);
    const pn = await agentWs(ws);
    const m = model([{ text: 'x' }]);
    const g = stubGraph();
    const old = { id: 'wamid.old.1', from: WA_1, type: 'text', text: { body: 'قديمة' }, timestamp: String(Math.floor(Date.now() / 1000) - 25 * 3600) };
    await say(ws, pn, old, g);
    expect(m.callCount).toBe(0);
    expect(sendCount(g)).toBe(0);
  });

  it('a customer erased while the model is thinking gets nothing and leaves nothing', async () => {
    const ws = W(14);
    const pn = await agentWs(ws);
    // Erase exactly while the model is answering: a sleep cannot promise that under load.
    // Plain flags, each side polling on its own timer: no promise crosses between the test and the Durable Object.
    let thinking = false;
    let released = false;
    model([{ text: 'رد', onStart: () => { thinking = true; }, holdUntil: () => released }]);
    const g = stubGraph();
    const turn = say(ws, pn, text('hi'), g);
    await vi.waitFor(() => expect(thinking).toBe(true));
    await workspace(ws).eraseContact(WA_1);
    released = true;
    await turn;
    expect(sendCount(g)).toBe(0);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM agent_turns')).toEqual([]);
  });

  it('a stop sent while the model is thinking cancels the answer', async () => {
    const ws = W(15);
    const pn = await agentWs(ws);
    let thinking = false;
    let released = false;
    model([{ text: 'رد', onStart: () => { thinking = true; }, holdUntil: () => released }]);
    const g = stubGraph();
    const turn = say(ws, pn, text('hi'), g);
    await vi.waitFor(() => expect(thinking).toBe(true));
    await exec(ws, 'UPDATE contacts SET opted_out_at = ?', Date.now() + 1000);
    released = true;
    await turn;
    expect(sendCount(g)).toBe(0);
  });

  it('a replayed task does not call the model or send again', async () => {
    const ws = W(16);
    const pn = await agentWs(ws);
    const m = model([{ text: 'مرة واحدة' }, { text: 'لا يجب' }]);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    const input = JSON.stringify({ messageId: (await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE direction = 'in'"))[0]!.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'text', text: 'hi', reply: null, order: null });
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('bot_turn', 0, ?)", input);
    await workspace(ws).runDueTasks();
    expect(m.callCount).toBe(1);
    expect(sendCount(g)).toBe(1);
  });

  it('sends 150 ms apart by default (ack, then the answer)', async () => {
    const ws = W(17);
    const pn = await agentWs(ws);
    await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 150; });
    await exec(ws, "INSERT INTO agent_state (key, value) VALUES ('latency_ewma_ms', '9000')");
    model([{ text: 'الرد' }]);
    const times: number[] = [];
    const g = stubGraph((c) => (times.push(Date.now()), { status: 200, json: { messages: [{ id: `wamid.o${times.length}` }] } }));
    await say(ws, pn, text('hi'), g);
    expect(times.length).toBe(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(140);
  });
});

describe('quick acknowledgement', () => {
  it('none when the model has been quick; one BEFORE the model when it has been slow', async () => {
    const ws = W(18);
    const pn = await agentWs(ws);
    model([{ text: 'سريع' }]);
    const g = stubGraph();
    expect((await say(ws, pn, text('a'), g)).map((s) => s.text)).toEqual(['سريع']);

    await exec(ws, "UPDATE agent_state SET value = '5000' WHERE key = 'latency_ewma_ms'");
    const seenAtCall: number[] = [];
    const slow = model([{ text: 'بطيء' }]);
    const orig = slow.complete.bind(slow);
    slow.complete = async (r) => (seenAtCall.push(sendCount(g)), orig(r));
    const out = await say(ws, pn, text('b'), g);
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.ack.ar, 'بطيء']);
    expect(seenAtCall).toEqual([sendCount(g) - 1]); // the ack was already out when the model was called
  });

  it('a turn that turns out slow acknowledges before running its tools', async () => {
    const ws = W(19);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item' } }], delayMs: 60 }, { text: 'لقيت' }]);
    const out = await say(ws, pn, text('عايز'), stubGraph());
    void m;
    // slowMs is 2000 by default: no ack; with a tiny slowMs the same turn acks once
    expect(out.map((s) => s.text)).toEqual(['لقيت']);
    const ws2 = W(20);
    const pn2 = await agentWs(ws2);
    const prev = (await import('../src/core/ai/config')).configureAgent({ slowMs: 30 });
    try {
      model([{ tools: [{ name: 'search_catalog', arguments: { query: 'item' } }], delayMs: 60 }, { text: 'لقيت' }]);
      const out2 = await say(ws2, pn2, text('عايز'), stubGraph());
      expect(out2.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.ack.ar, 'لقيت']);
    } finally {
      (await import('../src/core/ai/config')).configureAgent(prev);
    }
  });
});

describe('failures end in a handoff, never silence', () => {
  it('a retryable model failure is retried once, then answered', async () => {
    const ws = W(21);
    const pn = await agentWs(ws);
    const m = model([{ fail: new LlmError('rate_limited', true, 429) }, { text: 'تمام' }]);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(m.callCount).toBe(2);
    expect(out.map((s) => s.text)).toEqual(['تمام']);
  });

  it('a model that keeps failing hands over; the error is logged as a class only', async () => {
    const ws = W(22);
    const pn = await agentWs(ws);
    model([{ fail: new LlmError('http', false, 500) }]);
    const log: string[] = [];
    const spy = (await import('vitest')).vi.spyOn(console, 'error').mockImplementation((...a) => { log.push(a.join(' ')); });
    const out = await say(ws, pn, text('رقمي 01001234567'), stubGraph());
    spy.mockRestore();
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect(log.join('\n')).toContain('agent_model_failed');
    expect(log.join('\n')).not.toMatch(/0100123|رقمي/);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'provider_error' });
  });

  it.each([
    ['empty', ''],
    ['json leak', '{"tool_calls":[{"name":"x"}]}'],
    ['only thinking', '<think>hmm</think>'],
  ])('unusable output (%s) is never sent; the customer is handed over', async (n, bad) => {
    const ws = W(50 + ['empty', 'json leak', 'only thinking'].indexOf(n));
    const pn = await agentWs(ws);
    model([{ text: bad }]);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
  });

  it('thinking blocks are removed from a good answer; long answers are cut', async () => {
    const ws = W(40);
    const pn = await agentWs(ws);
    model([{ text: `<think>plan</think>${'ا'.repeat(2000)}` }]);
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(out[0]!.text!.length).toBeLessThanOrEqual(1500);
    expect(out[0]!.text).not.toContain('plan');
  });

  it('no usable model (not configured) hands over', async () => {
    const ws = W(41);
    const pn = await agentWs(ws);
    (await import('../src/core/ai/config')).configureAgent({ provider: () => null });
    const out = await say(ws, pn, text('hi'), stubGraph());
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'misconfigured' });
  });

  it('videos and files get one short "text only" note (a voice note is transcribed instead: test/voice-note.test.ts)', async () => {
    const ws = W(42);
    const pn = await agentWs(ws);
    const m = model([]);
    const out = await say(ws, pn, { ...audio(), type: 'video', video: { id: 'media-a', mime_type: 'video/mp4' } }, stubGraph());
    expect(out.map((s) => s.text)).toEqual([EBDA_AGENT_COPY.t.textOnly.ar]);
    expect(m.callCount).toBe(0);
  });
});

describe('a retried turn after a crash', () => {
  const replayInput = async (ws: string, pn: string, over: Record<string, unknown> = {}) => {
    const id = (await rows<{ id: number }>(ws, "SELECT id FROM messages WHERE direction = 'in' ORDER BY id LIMIT 1"))[0]!.id;
    return { id, json: JSON.stringify({ messageId: id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'text', text: 'hi', reply: null, order: null, ...over }) };
  };

  it('a turn retried after the 24 h window closed sends nothing, not even the text-only note', async () => {
    const ws = W(43);
    const pn = await agentWs(ws);
    model([]);
    const g = stubGraph();
    await say(ws, pn, audio(), g);
    expect(sendCount(g)).toBe(1);
    const { id, json } = await replayInput(ws, pn, { type: 'audio', text: null });
    await exec(ws, 'DELETE FROM agent_turns');
    await exec(ws, "DELETE FROM messages WHERE idempotency_key LIKE ?", `agent:${id}:%`);
    await exec(ws, 'UPDATE contacts SET last_inbound_at = ?', Math.floor(Date.now() / 1000) - 25 * 3600);
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('bot_turn', 0, ?)", json);
    const errs = vi.spyOn(console, 'error');
    await workspace(ws).runDueTasks();
    expect(errs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('bot_turn_failed'))).toEqual([]); // the late turn ends quietly instead of failing and retrying
    expect(sendCount(g)).toBe(1);
    expect(await rows(ws, 'SELECT 1 FROM messages WHERE idempotency_key LIKE ?', `agent:${id}:%`)).toEqual([]); // not even stored for sending
  });

  it('a turn whose credit was charged but whose replies were never stored does not call the model again', async () => {
    const ws = W(44);
    const pn = await agentWs(ws);
    const m = model([{ text: 'مرة واحدة' }, { text: 'مجاناً؟ لا' }]);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    const { id, json } = await replayInput(ws, pn);
    await exec(ws, 'DELETE FROM agent_turns'); // the crash: charged, then lost before the replies were stored
    await exec(ws, 'DELETE FROM messages WHERE idempotency_key LIKE ?', `agent:${id}:%`);
    const balance = (await workspace(ws).aiCredits()).balance;
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('bot_turn', 0, ?)", json);
    await workspace(ws).runDueTasks();
    expect(m.callCount).toBe(1);
    expect(sendCount(g)).toBe(1);
    expect((await workspace(ws).aiCredits()).balance).toBe(balance);
  });

  it('a turn whose replies were stored but not yet turn-recorded redelivers them without calling the model', async () => {
    const ws = W(45);
    const pn = await agentWs(ws);
    const m = model([{ text: 'مرة واحدة' }, { text: 'مجاناً؟ لا' }]);
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    const { json } = await replayInput(ws, pn);
    await exec(ws, 'DELETE FROM agent_turns');
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('bot_turn', 0, ?)", json);
    await workspace(ws).runDueTasks();
    expect(m.callCount).toBe(1);
    expect(sendCount(g)).toBe(1); // already sent: the claim finds it done
  });
});

