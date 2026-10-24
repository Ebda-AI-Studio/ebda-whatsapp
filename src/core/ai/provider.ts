/**
 * The model behind the AI agent. The agent loop only knows `LlmProvider`; Workers AI is the default and a merchant may bring
 * any OpenAI-compatible endpoint with their own key (white-label). Providers never log a prompt, a reply or a key: a failure
 * is an `LlmError` with a class and a retry hint, nothing else.
 */
import { z } from 'zod';

export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type LlmRequest = { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxTokens: number };
export type LlmResponse = { text?: string; toolCalls?: ToolCall[]; usage: { inputTokens: number; outputTokens: number } };

export interface LlmProvider {
  /** True when the merchant pays for the model (own key): such a workspace is never debited AI credits. */
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

export const LLM_TIMEOUT_MS = 25_000;
/** Reasoning models put their scratch work in <think> blocks; a customer must never see it. */
export const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const parseArgs = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw || '{}') as unknown;
  } catch {
    return { __unparseable: true };
  }
};

// ---- OpenAI wire format (shared by Workers AI's chat models and any compatible endpoint) ---------------------------------

function toWire(req: LlmRequest): { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[] {
  const out: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId, name: m.name });
    else out.push({ role: 'assistant', content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}) });
  }
  return out;
}
const toolsWire = (tools: ToolDef[]) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

const wireCall = z.object({ id: z.string().optional(), type: z.string().optional(), function: z.object({ name: z.string(), arguments: z.unknown().optional() }) });
const flatCall = z.object({ id: z.string().optional(), name: z.string(), arguments: z.unknown().optional() });
const usageSchema = z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional();
/** `choices[0].message` (OpenAI shape) or the older Workers AI `{ response, tool_calls }`. */
const chatResult = z.union([
  z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(wireCall).nullable().optional() }) })).min(1), usage: usageSchema }),
  z.object({ response: z.string().nullable().optional(), tool_calls: z.array(z.union([wireCall, flatCall])).nullable().optional(), usage: usageSchema }).refine((o) => o.response !== undefined || o.tool_calls !== undefined),
]);

export function readChatResult(raw: unknown): LlmResponse {
  const parsed = chatResult.safeParse(raw);
  if (!parsed.success) throw new LlmError('bad_response', false);
  const d = parsed.data;
  const message = 'choices' in d ? d.choices[0]!.message : { content: d.response, tool_calls: d.tool_calls };
  const calls: ToolCall[] = (message.tool_calls ?? []).map((c, i) => {
    const fn = 'function' in c ? c.function : c;
    return { id: c.id || `call_${i}`, name: fn.name, arguments: parseArgs(fn.arguments) };
  });
  const text = message.content ? stripThinking(message.content) : '';
  return {
    ...(text ? { text } : {}),
    ...(calls.length ? { toolCalls: calls } : {}),
    usage: { inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0 },
  };
}

// ---- Workers AI ---------------------------------------------------------------------------------------------------------

/** The slice of the `AI` binding we use. */
export type AiBinding = { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

export class WorkersAiProvider implements LlmProvider {
  readonly byoKey = false;
  constructor(private readonly ai: AiBinding, private readonly model: string) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    let raw: unknown;
    try {
      raw = await this.ai.run(this.model, { messages: toWire(req), ...(req.tools.length ? { tools: toolsWire(req.tools) } : {}), max_tokens: req.maxTokens, temperature: 0.3 });
    } catch (err) {
      // The binding throws an Error with the platform's text; classify without copying it.
      const text = err instanceof Error ? err.message : '';
      if (/429|capacity|rate/i.test(text)) throw new LlmError('rate_limited', true, 429);
      if (/timeout|timed out/i.test(text)) throw new LlmError('timeout', true);
      throw new LlmError('network', true);
    }
    return readChatResult(raw);
  }
}

// ---- OpenAI-compatible (bring your own key) -----------------------------------------------------------------------------

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly byoKey = true;
  constructor(private readonly cfg: { baseUrl: string; apiKey: string; model: string; fetcher?: typeof fetch; timeoutMs?: number }) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const doFetch = this.cfg.fetcher ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ model: this.cfg.model, messages: toWire(req), ...(req.tools.length ? { tools: toolsWire(req.tools) } : {}), max_tokens: req.maxTokens, temperature: 0.3 }),
        redirect: 'manual', // a merchant-supplied host must not bounce us (with the key) somewhere else
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? LLM_TIMEOUT_MS),
      });
    } catch (err) {
      throw new LlmError(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network', true);
    }
    if (res.status === 429) throw new LlmError('rate_limited', true, 429);
    if (!res.ok) throw new LlmError('http', res.status >= 500, res.status);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new LlmError('bad_response', false);
    }
    return readChatResult(body);
  }
}

/**
 * A merchant-supplied base URL is fetched from our network, so it must be a public HTTPS host: no credentials, no IP
 * literal, no single-label or internal-looking name. (DNS rebinding to a private address cannot be excluded from inside a
 * Worker; Workers cannot reach private networks, and the redirect is never followed.)
 */
export function validBaseUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid|example)$/.test(host)) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}
