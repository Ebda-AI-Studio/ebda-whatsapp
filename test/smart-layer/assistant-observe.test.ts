import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import { EMPTY_ANSWER, ENGINE_FALLBACK, NO_STORE_METRICS, TOOL_FAILED, observeTurn, withLowReasoning, CHIP_RULE } from '../../src/routes/assistant-observe';
import { apiFor, storeId, useApiKey } from '../helpers/api';
import { workspace } from '../helpers/workspace';
import { MSG } from '../../foundation/smart-layer/loop';
import type { SmartLayerAdapter, ToolSpec } from '../../foundation/smart-layer/types';

useApiKey();

// WA-ASSIST-OBS-1: "كام طلب جالي النهارده؟" answered the generic fallback 3/3 on Amelia with a 200 and no log line. The engine swallows a model that returns no content
// (and a failed tool read) into the same sentence; these tests pin the three seams Chat owns.
type Msg = { content?: string };
const emptyAi = () => {
  let modelCalls = 0;
  const requests: Array<{ tools: unknown; max_tokens: unknown }> = [];
  return {
    requests,
    calls: () => modelCalls,
    ai: { run: async (_m: string, inputs: Record<string, unknown>) => {
      const system = ((inputs.messages as Msg[])[0]?.content ?? '') as string;
      if (system.includes('Classify the merchant message')) return { choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      modelCalls++;
      requests.push({ tools: inputs.tools, max_tokens: inputs.max_tokens });
      return { choices: [{ message: { content: null } }], usage: { prompt_tokens: 10, completion_tokens: 900 } };
    } },
  };
};
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"answer-only\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); vi.restoreAllMocks(); });

describe('assistant route: a model that returns nothing', () => {
  it('is retried once with the SAME tools and a bigger budget, logged with a request id, and told to the merchant as an empty answer (not the generic "could not answer")', async () => {
    const s = storeId(7101);
    const { token } = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    const m = emptyAi();
    configureAssistant({ ai: m.ai as never, help: { db: env.DB, embed: async (t: string[]) => t.map(() => [0]), vectors: { upsert: async () => ({ mutationId: 'm' }), deleteByIds: async () => ({ mutationId: 'm' }), query: async () => ({ count: 0, matches: [] }) } as never } });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((x: unknown) => { lines.push(String(x)); });
    const res = await SELF.fetch(`https://x/api/v1/stores/${s}/assistant/turn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ conversationId: crypto.randomUUID(), text: 'فين رصيد المحفظة؟', locale: 'ar' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; segments: Array<{ text: string }> };
    expect(body.segments[0]!.text).toBe(MSG.emptyModel.ar); // the engine (foundation v0.4.2) now says it itself; Chat's EMPTY_ANSWER is the same sentence
    expect(EMPTY_ANSWER).toEqual(MSG.emptyModel);
    expect(body.segments[0]!.text).not.toBe(ENGINE_FALLBACK.ar);
    expect(body.status).toBe('limited');
    expect(m.calls()).toBe(2); // first completion + one retry
    expect(m.requests[1]!.tools).toEqual(m.requests[0]!.tools); // never tools-off: it could then invent a figure
    expect(m.requests[1]!.max_tokens).toBeGreaterThan(m.requests[0]!.max_tokens as number);
    const rid = res.headers.get('x-request-id')!;
    expect(rid).toMatch(/[0-9a-f-]{36}/);
    const parsed = lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as { event: string; requestId: string });
    for (const ev of ['assistant_model_empty', 'assistant_model_empty_after_retry', 'assistant_turn']) expect(parsed.find((p) => p.event === ev)?.requestId, ev).toBe(rid);
  });
});

describe('observeTurn: seams', () => {
  const adapterWith = (tool: ToolSpec, ai: { run: (m: string, i: Record<string, unknown>) => Promise<unknown> }): SmartLayerAdapter => ({
    ai, models: { answer: 'm', plan: 'm', template: 'm', classify: 'm', judge: 'm', embed: 'm' },
    tools: () => [tool], storage: { appendAudit: async () => undefined },
  } as unknown as SmartLayerAdapter);

  it('a throwing tool read is logged with tool name + upstream status, rethrown, and the fallback is replaced by the tool message', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const tool = { name: 'orders_today', policy: 'free', read: async () => { throw Object.assign(new Error('route answered 502'), { name: 'ToolApiError', status: 502 }); } } as unknown as ToolSpec;
    const o = observeTurn(adapterWith(tool, { run: async () => ({}) }), { storeId: 's', log: (l) => lines.push(l) });
    await expect(o.adapter.tools()[0]!.read!({} as never, {})).rejects.toThrow('502');
    expect(lines[0]).toMatchObject({ event: 'assistant_tool_failed', tool: 'orders_today', error: 'ToolApiError', upstreamStatus: 502, requestId: o.requestId });
    const r = o.refine({ status: 'answered', segments: [{ kind: 'text', text: ENGINE_FALLBACK.en }] }, 'en');
    expect(r.segments).toEqual([{ kind: 'text', text: TOOL_FAILED.en }]);
  });

  it('a provider error is logged with its kind and still thrown; a real answer is never rewritten', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const o = observeTurn(adapterWith({ name: 't', policy: 'free' } as unknown as ToolSpec, { run: async () => { throw new Error('request timed out'); } }), { storeId: 's', log: (l) => lines.push(l) });
    await expect(o.provider.complete({ system: 's', messages: [], tools: [], maxTokens: 10 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(lines[0]).toMatchObject({ event: 'assistant_model_error', kind: 'timeout' });
    const ok = { status: 'answered', segments: [{ kind: 'text' as const, text: 'جالك 5 طلبات' }] };
    expect(o.refine(ok, 'ar')).toBe(ok);
  });
});

describe('observeTurn: store-wide metrics questions', () => {
  const adapter = (): SmartLayerAdapter => ({ ai: { run: async () => ({}) }, models: { answer: 'm', plan: 'm', template: 'm', classify: 'm', judge: 'm', embed: 'm' }, tools: () => [], storage: { appendAudit: async () => undefined } } as unknown as SmartLayerAdapter);
  const say = (text: string) => ({ status: 'answered', segments: [{ kind: 'text' as const, text }] });
  const indic = (n: string): string => [...n].map((d) => String.fromCharCode(0x660 + Number(d))).join('');
  const digits = (r: { segments: Array<{ kind: string; text?: string }> }) => r.segments.map((s) => s.text ?? '').join('').match(/[0-9\u0660-\u0669]+/g);

  it('orders today with no matching tool: an invented number never reaches the merchant (AR digits, Latin digits, English)', () => {
    const o = observeTurn(adapter(), { storeId: 's', log: () => undefined });
    for (const [q, lang, a] of [['كام طلب جالي النهارده؟', 'ar', 'النهاردة جالك 12 طلب'], ['كام طلب جالي النهارده؟', 'ar', `جالك ${indic('12')} طلب النهاردة`], ['How many orders did I get today?', 'en', 'You got 12 orders today.'], ['كام مبيعاتي النهارده', 'ar', 'مبيعاتك 4,500 جنيه']] as const) {
      const r = o.refine(say(a), lang, q);
      expect(digits(r)).toBeNull();
      expect(r.segments[0]).toEqual({ kind: 'text', text: NO_STORE_METRICS[lang] });
    }
  });

  it('keeps an honest answer without figures, and keeps a figure a tool really returned', async () => {
    const tool = { name: 'x', policy: 'free', read: async () => ({ ordersToday: 7 }) } as unknown as ToolSpec;
    const o = observeTurn({ ...adapter(), tools: () => [tool] }, { storeId: 's', log: () => undefined });
    const honest = say('مفيش عندي أرقام الطلبات، شوفها من لوحة المتجر');
    expect(o.refine(honest, 'ar', 'كام طلب جالي النهارده؟')).toBe(honest);
    await o.adapter.tools()[0]!.read!({} as never, {});
    const real = say('جالك 7 طلبات');
    expect(o.refine(real, 'ar', 'كام طلب جالي النهارده؟')).toBe(real);
    const other = say('جالك 12 طلب');
    expect(digits(o.refine(other, 'ar', 'كام طلب جالي النهارده؟'))).toBeNull();
  });
});

describe('assistant route: store-wide metrics never reach the model (live: orders-today came back empty every time)', () => {
  const ask = async (s: string, token: string, text: string, locale: 'ar' | 'en') => {
    const res = await SELF.fetch(`https://x/api/v1/stores/${s}/assistant/turn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ conversationId: crypto.randomUUID(), text, locale }) });
    return { res, body: (await res.json()) as { status: string; segments: Array<{ text: string }> } };
  };
  const help = { db: env.DB, embed: async (t: string[]) => t.map(() => [0]), vectors: { upsert: async () => ({ mutationId: 'm' }), deleteByIds: async () => ({ mutationId: 'm' }), query: async () => ({ count: 0, matches: [] }) } as never };

  it('orders / sales today: the fixed honest answer with no model call, even if the model would have returned nothing or a number', async () => {
    const s = storeId(7102);
    const { token } = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    const m = emptyAi();
    configureAssistant({ ai: m.ai as never, help });
    for (const [q, lang] of [['كام طلب جالي النهارده؟', 'ar'], ['إجمالي المبيعات النهارده كام؟', 'ar'], ['How many orders did I get today?', 'en']] as const) {
      const { res, body } = await ask(s, token, q, lang);
      expect(res.status).toBe(200);
      expect(body.segments).toEqual([{ kind: 'text', text: NO_STORE_METRICS[lang] }]);
      expect(body.segments[0]!.text).not.toMatch(/[0-9]/);
    }
    expect(m.calls()).toBe(0); // the model was never asked: nothing it returns can be empty or invented
  });

  it('a question that is not a store-wide figure still goes to the model', async () => {
    const s = storeId(7103);
    const { token } = await apiFor(s);
    await workspace(s).setAssistantMode('answer-only');
    const m = emptyAi();
    configureAssistant({ ai: m.ai as never, help });
    await ask(s, token, 'فين رصيد المحفظة؟', 'ar');
    await ask(s, token, 'اطلب قالب جديد النهارده', 'ar');
    expect(m.calls()).toBeGreaterThan(0);
  });
});

describe('GLM reasoning budget (live: agent-settings question came back empty, outputTokens = maxTokens)', () => {
  it('a glm request carries reasoning_effort low, other models and an explicit value are untouched', async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const ai = withLowReasoning({ run: async (m, i) => { seen.push([m, i]); return {}; } });
    await ai.run('@cf/zai-org/glm-5.3', { max_tokens: 700 });
    await ai.run('@cf/openai/gpt-oss-120b', { max_tokens: 700 });
    await ai.run('@cf/zai-org/glm-5.3', { reasoning_effort: 'high' });
    expect(seen[0]![1]).toEqual({ max_tokens: 700, reasoning_effort: 'low' });
    expect(seen[1]![1]).toEqual({ max_tokens: 700 });
    expect(seen[2]![1]).toEqual({ reasoning_effort: 'high' });
  });
  it('the provider the route uses sends it on the real turn path (checked end to end through observeTurn)', async () => {
    let sent: Record<string, unknown> | undefined;
    const adapter = { ai: { run: async (_m: string, i: Record<string, unknown>) => { sent = i; return { choices: [{ message: { content: 'تمام' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } }, models: { answer: '@cf/zai-org/glm-5.3', plan: 'x', template: 'x', classify: 'x', judge: 'x', embed: 'x' }, tools: () => [], storage: { appendAudit: async () => undefined } } as unknown as SmartLayerAdapter;
    const o = observeTurn(adapter, { storeId: 's', log: () => undefined });
    await o.provider.complete({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 700, model: '@cf/zai-org/glm-5.3' });
    expect(sent!.reasoning_effort).toBe('low');
  });
});

describe('capability chip wording', () => {
  it('every model request carries the chip rule once (standalone pointer, never a word in a sentence), also on the empty-completion retry', async () => {
    const systems: string[] = [];
    const adapter = { ai: { run: async (_m: string, i: Record<string, unknown>) => { systems.push(((i.messages as Array<{ content: string }>)[0]!.content)); return { choices: [{ message: { content: null } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }; } }, models: { answer: 'm', plan: 'm', template: 'm', classify: 'm', judge: 'm', embed: 'm' }, tools: () => [], storage: { appendAudit: async () => undefined } } as unknown as SmartLayerAdapter;
    const o = observeTurn(adapter, { storeId: 's', log: () => undefined });
    await o.provider.complete({ system: 'BASE', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 10 });
    expect(systems.length).toBe(2); // first call + the empty retry
    for (const s of systems) {
      expect(s.startsWith('BASE')).toBe(true);
      expect(s.split(CHIP_RULE).length - 1).toBe(1);
    }
    expect(CHIP_RULE).toContain('شوف: [[cap:...]]');
    expect(CHIP_RULE).toContain('روابط مفيدة:');
    expect(CHIP_RULE).toContain('See: [[cap:...]]');
    expect(CHIP_RULE).toMatch(/never use it as a word inside a sentence/i);
  });
});
