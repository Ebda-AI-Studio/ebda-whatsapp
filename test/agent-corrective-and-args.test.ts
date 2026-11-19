import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_RETRY_NOTE, GPT_OSS_MODEL } from '../src/core/ai/model-flag';
import { MAX_MODEL_CALLS_PER_CREDIT } from '../src/core/ai/agent';
import { tidyArgs } from '../src/core/ai/tools';
import { configureSessionCheck } from '../src/core/identity/session';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { OP1, operatorCall, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

useApiKey();
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000098${String(n).padStart(2, '0')}`;
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const agentWs = async (ws: string, settings: Record<string, unknown> = {}) => {
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};
const credits = async (ws: string) => (await workspace(ws).getAgentSettings()).credits;
const outcome = async (ws: string) => (await rows<{ outcome: string }>(ws, 'SELECT outcome FROM agent_turns ORDER BY rowid DESC LIMIT 1'))[0]?.outcome;
const flip = (m: string | null) => operatorCall(OP1, 'PUT', '/agent/model', { model: m, reason: 'corrective call tests' });
beforeEach(async () => { configureSessionCheck(async () => false); await env.DB.prepare("DELETE FROM platform_flags WHERE key = 'agent.model'").run(); });
afterEach(() => configureSessionCheck(null));

describe('tool arguments: null / "" is absent, a numeric budget string is a number (every model)', () => {
  it('tidyArgs', () => {
    expect(tidyArgs({ query: 'x', maxPrice: null }, ['maxPrice'])).toEqual({ query: 'x' });
    expect(tidyArgs({ orderNumber: '' }, ['orderNumber'])).toEqual({});
    expect(tidyArgs({ orderNumber: '  ' }, ['orderNumber'])).toEqual({});
    expect(tidyArgs({ query: 'x', maxPrice: '500' }, ['maxPrice'])).toEqual({ query: 'x', maxPrice: 500 });
    expect(tidyArgs({ query: 'x', maxPrice: ' 99.5 ' }, ['maxPrice'])).toEqual({ query: 'x', maxPrice: 99.5 });
    expect(tidyArgs({ query: '' }, ['maxPrice'])).toEqual({ query: '' }); // a required field is never dropped
    expect(tidyArgs({ query: 'x', maxPrice: '1e9' }, ['maxPrice'])).toEqual({ query: 'x', maxPrice: '1e9' }); // not a plain number: left for the schema to refuse
    expect(tidyArgs('nope', ['x'])).toBe('nope');
    expect(tidyArgs(null, ['x'])).toBeNull();
  });

  const toolResult = async (n: number, args: unknown, name = 'search_catalog') => {
    const ws = W(n);
    const pn = await agentWs(ws);
    const m = model([{ tools: [{ name, arguments: args }] }, { text: 'تمام' }]);
    await say(ws, pn, text('عايز حاجة'), stubGraph());
    return m.calls[1]!.messages.find((x) => x.role === 'tool')!.content;
  };
  it('the real failing shapes now run the tool: order_status with orderNumber "", search with maxPrice null / "500" / a missing key', async () => {
    expect(await toolResult(1, { orderNumber: '' }, 'order_status')).not.toContain('invalid_arguments');
    expect(await toolResult(2, { query: 'item', maxPrice: null })).not.toContain('invalid_arguments');
    expect(await toolResult(3, { query: 'item', maxPrice: '500' })).not.toContain('invalid_arguments');
    expect(await toolResult(4, { query: 'item', limit: 3, extra: { a: 1 } })).not.toContain('invalid_arguments'); // unknown keys ignored
  });
  it('genuinely invalid arguments are still refused', async () => {
    expect(await toolResult(5, { query: '' })).toContain('invalid_arguments');
    expect(await toolResult(6, {})).toContain('invalid_arguments');
    expect(await toolResult(7, { query: 'item', maxPrice: 'cheap' })).toContain('invalid_arguments');
    expect(await toolResult(8, { query: 'item', maxPrice: -5 })).toContain('invalid_arguments');
    expect(await toolResult(9, { query: 'item', maxPrice: 5_000_000 })).toContain('invalid_arguments');
    expect(await toolResult(10, { query: 'item', maxPrice: '5000000' })).toContain('invalid_arguments');
    expect(await toolResult(11, { orderNumber: 'a b!' }, 'order_status')).toContain('invalid_arguments');
    expect(await toolResult(12, { ids: [] }, 'show_products')).toContain('invalid_arguments');
  });
});

describe('an empty final answer gets ONE nudge (every model)', () => {
  it('empty -> one nudge -> the text is sent, one credit, the nudge is a user turn with tools off', async () => {
    const ws = W(20);
    const pn = await agentWs(ws);
    const m = model([{ text: '' }, { text: 'أهلاً بيك' }]);
    const out = await say(ws, pn, text('مساء الخير'), stubGraph());
    expect(out.map((s) => s.text)).toEqual(['أهلاً بيك']);
    expect(m.callCount).toBe(2);
    expect(m.calls[1]!.tools).toEqual([]);
    expect(m.calls[1]!.messages.at(-1)).toEqual({ role: 'user', content: EMPTY_RETRY_NOTE });
    expect(await credits(ws)).toBe(999);
  });
  it('still empty -> handoff:no_answer as before, and no third call', async () => {
    const ws = W(21);
    const pn = await agentWs(ws);
    const m = model([{ text: '' }, { text: '  ' }, { text: 'never used' }]);
    await say(ws, pn, text('مساء الخير'), stubGraph());
    expect(m.callCount).toBe(2);
    expect(await outcome(ws)).toBe('handoff:no_answer');
    expect(await credits(ws)).toBe(999);
  });
  it('no retry when there is text; a failing retry keeps no_answer', async () => {
    const ws = W(22);
    const pn = await agentWs(ws);
    const m = model([{ text: 'تمام' }]);
    await say(ws, pn, text('hi'), stubGraph());
    expect(m.callCount).toBe(1);
    const m2 = model([{ text: '' }, { fail: new Error('boom') }]);
    await say(ws, pn, text('hello'), stubGraph());
    expect(m2.callCount).toBe(2);
    expect(await outcome(ws)).toBe('handoff:no_answer');
  });
  it('after three tool rounds the last answer can be nudged once: 5 calls, one credit, never more', async () => {
    const ws = W(23);
    const pn = await agentWs(ws);
    const tool = { tools: [{ name: 'search_catalog', arguments: { query: 'item' } }] };
    const m = model([tool, tool, tool, { text: '' }, { text: 'دي النتيجة' }, { text: 'never' }]);
    const out = await say(ws, pn, text('عايز item'), stubGraph());
    expect(m.callCount).toBe(MAX_MODEL_CALLS_PER_CREDIT);
    expect(out.map((s) => s.text)).toEqual(['دي النتيجة']);
    expect(await credits(ws)).toBe(999);
  });
});

describe('the guard stays the last word: a refused reply is NOT corrected, for any model', () => {
  const budgetEcho = 'Here are gifts under 600 EGP, take a look.';
  it('default and flagged: the refused reply is one call and a handoff:guarded; an invented link is the same', async () => {
    for (const [n, flag] of [[30, null], [31, GPT_OSS_MODEL]] as const) {
      const ws = W(n);
      const pn = await agentWs(ws, { language: 'auto' });
      await flip(flag);
      const m = model([{ text: budgetEcho }, { text: 'never' }]);
      await say(ws, pn, text('I need a gift under 600 EGP'), stubGraph());
      expect(m.callCount).toBe(1);
      expect(await outcome(ws)).toBe('handoff:guarded');
      const ws2 = W(n + 10);
      const pn2 = await agentWs(ws2, { language: 'auto' });
      const m2 = model([{ text: 'Buy at https://evil.example/x now' }, { text: 'never' }]);
      await say(ws2, pn2, text('hello there'), stubGraph());
      expect(m2.callCount).toBe(1);
      expect(await outcome(ws2)).toBe('handoff:guarded');
    }
  });
  it('the corrective slot is shared: an empty answer is nudged once, and an Arabic reply to an English ask after that is NOT corrected again', async () => {
    const ws = W(35);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    const m = model([{ text: '' }, { text: 'عندنا هدايا حلوة' }, { text: 'never' }]);
    const out = await say(ws, pn, text('any gifts?'), stubGraph());
    expect(m.callCount).toBe(2);
    expect(out.map((s) => s.text)).toEqual(['عندنا هدايا حلوة']);
  });
});

describe('cleanReply: model control tokens never reach a customer', () => {
  it('a reply that is (or contains) a harmony control token is unusable', async () => {
    const { cleanReply } = await import('../src/core/ai/agent');
    expect(cleanReply('<|start|>assistant<|channel|>')).toBeNull();
    expect(cleanReply('تمام <|channel|> أهلاً')).toBeNull();
    expect(cleanReply('أهلاً بيك، تحت أمرك')).toBe('أهلاً بيك، تحت أمرك');
    expect(cleanReply('2 < 3 | 4 > 1')).toBe('2 < 3 | 4 > 1'); // ordinary angle brackets and pipes are fine
  });
});

// A fresh sender: this file already spends most of the 30 AI turns/day one customer (WA_1) may use, and a refused turn makes no model call.
const FRESH = '201555000777';
describe('completion budget: the flagged model gets room for its hidden reasoning', () => {
  it('the default model asks for AGENT_MAX_TOKENS', async () => {
    const { AGENT_MAX_TOKENS } = await import('../src/core/ai/agent');
    const ws = W(40);
    const pn = await agentWs(ws);
    const m = model([{ text: 'أهلاً بيك' }]);
    await say(ws, pn, text('مساء الخير', FRESH), stubGraph());
    expect(m.calls.map((c) => c.maxTokens)).toEqual([AGENT_MAX_TOKENS]);
  });
  it('the flagged gpt-oss model asks for FLAGGED_MAX_TOKENS on every call of the turn, the corrective call included', async () => {
    const { AGENT_MAX_TOKENS, FLAGGED_MAX_TOKENS } = await import('../src/core/ai/agent');
    const ws = W(41);
    const pn = await agentWs(ws, { language: 'auto' });
    await flip(GPT_OSS_MODEL);
    const m = model([{ text: '' }, { text: 'عندنا هدايا حلوة' }]);
    await say(ws, pn, text('any gifts?', FRESH), stubGraph());
    expect(m.calls.map((c) => c.maxTokens)).toEqual([FLAGGED_MAX_TOKENS, FLAGGED_MAX_TOKENS]);
    expect(FLAGGED_MAX_TOKENS).toBeGreaterThan(AGENT_MAX_TOKENS);
  });
});
