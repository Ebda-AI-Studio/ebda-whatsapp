/**
 * The model behind the AI agent. The agent loop only knows `LlmProvider`; Workers AI is the default and a merchant may bring
 * any OpenAI-compatible endpoint with their own key (white-label). Providers never log a prompt, a reply or a key: a failure
 * is an `LlmError` with a class and a retry hint, nothing else.
 */
import { fetchWithTimeout } from '../net/fetch-with-timeout';

// The model boundary moved into the Smart Layer engine (plan 4 A10); Chat keeps one copy of it through the vendored foundation.
import { LlmError, readChatResult, stripThinking, WorkersAiProvider } from '../../../foundation/smart-layer/provider';
import type { AiBinding, ChatTurn, LlmErrorKind, LlmProvider, LlmRequest, LlmResponse, ToolCall, ToolDef } from '../../../foundation/smart-layer/provider';
export { LlmError, readChatResult, stripThinking, WorkersAiProvider };
export type { AiBinding, ChatTurn, LlmErrorKind, LlmProvider, LlmRequest, LlmResponse, ToolCall, ToolDef };

export const LLM_TIMEOUT_MS = 25_000;

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


// ---- OpenAI-compatible (bring your own key) -----------------------------------------------------------------------------

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly byoKey = true;
  constructor(private readonly cfg: { baseUrl: string; apiKey: string; model: string; fetcher?: typeof fetch; timeoutMs?: number }) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const doFetch = this.cfg.fetcher;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({ model: this.cfg.model, messages: toWire(req), ...(req.tools.length ? { tools: toolsWire(req.tools) } : {}), max_tokens: req.maxTokens, temperature: 0.3 }),
        redirect: 'manual', // a merchant-supplied host must not bounce us (with the key) somewhere else
      }, { label: 'ai.complete', class: 'ai', timeoutMs: this.cfg.timeoutMs ?? LLM_TIMEOUT_MS }, doFetch);
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

/** Hosts a merchant may point the agent at without an operator decision (exact names, https only). */
export const DEFAULT_PROVIDER_HOSTS: readonly string[] = ['api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com', 'openrouter.ai', 'api.groq.com', 'api.together.xyz', 'api.mistral.ai', 'api.deepseek.com', 'api.x.ai'];

/** The generic half of the checks below (shared with connectors, which have no provider list): the parsed URL and its normalised host, or null. */
export function publicHttpsHost(raw: string): { url: URL; host: string } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || !host.includes('.') || host.includes(':') || host.startsWith('[') || /^[\d.x]+$/i.test(host) || /^\d/.test(host.split('.').pop() ?? '')) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet|test|invalid|example|localdomain)$/.test(host)) return null;
  return { url: u, host };
}

/**
 * A merchant-supplied base URL is fetched from our network with their key, so it must be a known provider host (the default
 * list plus the operator's `extraHosts`) AND pass the generic checks: https on 443, no credentials/query/fragment, the host
 * normalised first (lower case, trailing dots stripped), no IP literal in any notation (the URL parser has already turned
 * decimal/hex/octal and IPv4-mapped forms into dotted/bracketed ones, all refused here), no internal-looking name.
 * Returns the cleaned URL or null.
 */
export function validBaseUrl(raw: string, extraHosts: readonly string[] = []): string | null {
  const parts = publicHttpsHost(raw);
  if (!parts) return null;
  const allowed = new Set([...DEFAULT_PROVIDER_HOSTS, ...extraHosts.map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))]);
  if (!allowed.has(parts.host)) return null;
  return `https://${parts.host}${parts.url.pathname.replace(/\/+$/, '')}`;
}
