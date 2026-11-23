/**
 * The model boundary of the Smart Layer (plan 4 Task A10). The loop only knows `LlmProvider`; Workers AI is the only provider
 * the engine ships (spec 6.2). Moved from Ebda Chat `src/core/ai/provider.ts` without the Zod parsing (engine rule: no deps) and
 * without the OpenAI-compatible BYOK provider, which stays in Chat. Providers never carry a prompt, a reply or a key in an error.
 */
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type LlmRequest = { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxTokens: number; model?: string };
export type LlmResponse = { text?: string; toolCalls?: ToolCall[]; usage: { inputTokens: number; outputTokens: number } };

export interface LlmProvider {
  readonly byoKey: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = 'timeout' | 'network' | 'rate_limited' | 'http' | 'bad_response' | 'unconfigured';
/** Never carries a response body or prompt text: the message is a fixed phrase. */
export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, readonly retryable: boolean, readonly status?: number) {
    super(`llm ${kind}${status ? ` ${status}` : ''}`);
    this.name = 'LlmError';
  }
}

/** The slice of the `AI` binding the engine uses. */
export type AiBinding = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

/** Reasoning models put scratch work in think blocks; a merchant must never see it. */
export const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

const parseArgs = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw || '{}') as unknown;
  } catch {
    return { __unparseable: true };
  }
};

// An assistant turn that only calls tools has NO text. Workers AI's chat schema rejects `content: null` (HTTP 400 code 5006, measured 2026-11-17 on
// the Llama 3.3 70B fast model), which turned every tool-using turn into a provider error; an empty string is accepted by Workers AI and OpenAI alike.
function toWire(req: LlmRequest): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name });
    else out.push({ role: 'assistant', content: m.content ?? '', ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}) });
  }
  return out;
}
const toolsWire = (tools: ToolDef[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Reads `choices[0].message` (OpenAI shape) or the older Workers AI `{ response, tool_calls }`. Anything else is `bad_response`. */
export function readChatResult(raw: unknown): LlmResponse {
  if (!isObj(raw)) throw new LlmError('bad_response', false);
  let content: unknown;
  let rawCalls: unknown;
  if (Array.isArray(raw.choices)) {
    const msg = isObj(raw.choices[0]) ? (raw.choices[0] as Record<string, unknown>).message : undefined;
    if (!isObj(msg)) throw new LlmError('bad_response', false);
    content = msg.content;
    rawCalls = msg.tool_calls;
  } else if ('response' in raw || 'tool_calls' in raw) {
    content = raw.response;
    rawCalls = raw.tool_calls;
  } else throw new LlmError('bad_response', false);
  if (content != null && typeof content !== 'string') throw new LlmError('bad_response', false);
  if (rawCalls != null && !Array.isArray(rawCalls)) throw new LlmError('bad_response', false);
  const calls: ToolCall[] = (rawCalls ?? []).map((c, i) => {
    if (!isObj(c)) throw new LlmError('bad_response', false);
    const fn = isObj(c.function) ? c.function : c;
    if (typeof fn.name !== 'string' || !fn.name) throw new LlmError('bad_response', false);
    return { id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, name: fn.name, arguments: parseArgs(fn.arguments) };
  });
  const text = typeof content === 'string' ? stripThinking(content) : '';
  const u = isObj(raw.usage) ? raw.usage : {};
  return {
    ...(text ? { text } : {}),
    ...(calls.length ? { toolCalls: calls } : {}),
    usage: { inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0, outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0 },
  };
}

export class WorkersAiProvider implements LlmProvider {
  readonly byoKey = false;
  /** `model` is a default; a request may carry its own (per-job routing). */
  constructor(private readonly ai: AiBinding, private readonly model: string) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    let raw: unknown;
    try {
      raw = await this.ai.run(req.model ?? this.model, { messages: toWire(req), ...(req.tools.length ? { tools: toolsWire(req.tools) } : {}), max_tokens: req.maxTokens, temperature: 0.3 });
    } catch (err) {
      // The binding throws with the platform's text; classify without copying it.
      const text = err instanceof Error ? err.message : '';
      if (/429|capacity|rate/i.test(text)) throw new LlmError('rate_limited', true, 429);
      if (/timeout|timed out/i.test(text)) throw new LlmError('timeout', true);
      throw new LlmError('network', true);
    }
    return readChatResult(raw);
  }
}
