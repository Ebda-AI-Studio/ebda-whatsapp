/**
 * Observability for one assistant turn (WA-ASSIST-OBS-1). The engine (`foundation/smart-layer/loop.ts`, vendored, not editable here) swallows every model, tool and rail
 * failure into a fixed reply, so a broken tool and a model that returned nothing looked the same in production: a 200 saying "I could not answer just now" and nothing in the logs.
 * This module wraps the three seams Chat owns (model provider, tool reads, audit write) so each failure leaves one JSON log line carrying the request id, and so
 * an empty model completion is retried once and, if it stays empty, is told to the merchant as what it is. Logs carry names, kinds, counts and timings: never a prompt, a reply or a secret.
 */
import { LlmError, WorkersAiProvider, type LlmProvider, type LlmRequest, type LlmResponse } from '../../foundation/smart-layer/provider';
import type { AuditRow, Segment, SmartLayerAdapter, ToolSpec } from '../../foundation/smart-layer/types';

type L = { ar: string; en: string };
/** The engine's own provider-failure sentence (loop.ts MSG.providerFail): the reply the merchant got when nothing real was produced. */
export const ENGINE_FALLBACK: L = { ar: 'مقدرتش أرد دلوقتي. جرّب تاني بعد لحظة.', en: 'I could not answer just now. Please try again in a moment.' };
export const TOOL_FAILED: L = { ar: 'مقدرتش أقرا بيانات متجرك دلوقتي. جرّب تاني بعد لحظة.', en: 'I could not read your store data right now. Please try again in a moment.' };
export const EMPTY_ANSWER: L = { ar: 'الرد جه فاضي من المساعد. جرّب تسأل بصيغة تانية أو ابعت السؤال تاني.', en: 'The assistant came back with an empty answer. Try rephrasing, or send the question again.' };

const NUDGE = 'Write the final answer to the merchant now, in plain text, using the data above. Do not call any tool.';

export type TurnObserver = {
  requestId: string;
  adapter: SmartLayerAdapter;
  provider: LlmProvider;
  /** Swaps the engine's generic fallback for the specific reason, when there is one. */
  refine<T extends { status: string; segments: Segment[] }>(res: T, locale: 'ar' | 'en'): T;
};

export function observeTurn(adapter: SmartLayerAdapter, o: { storeId: string; log?: (line: Record<string, unknown>) => void }): TurnObserver {
  const requestId = crypto.randomUUID();
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));
  const emit = (event: string, f: Record<string, unknown>) => log({ event, requestId, storeId: o.storeId, ...f });
  const state = { toolFailed: false, emptyFinal: false };

  const inner = new WorkersAiProvider(adapter.ai, adapter.models.answer);
  const provider: LlmProvider = {
    byoKey: false,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const t0 = Date.now();
      const run = async (r: LlmRequest): Promise<LlmResponse> => {
        try {
          return await inner.complete(r);
        } catch (err) {
          emit('assistant_model_error', { kind: err instanceof LlmError ? err.kind : 'unknown', status: err instanceof LlmError ? err.status : undefined, model: r.model ?? adapter.models.answer, ms: Date.now() - t0 });
          throw err;
        }
      };
      let res = await run(req);
      const empty = (x: LlmResponse) => !x.text && !x.toolCalls?.length;
      if (empty(res)) {
        // A reasoning model can spend the whole output budget on thinking and return no content. One retry, tools off, a bigger budget.
        emit('assistant_model_empty', { model: req.model ?? adapter.models.answer, outputTokens: res.usage.outputTokens, maxTokens: req.maxTokens, ms: Date.now() - t0 });
        const again = await run({ ...req, tools: [], maxTokens: Math.min(req.maxTokens * 2, 4096), messages: [...req.messages, { role: 'user', content: NUDGE }] });
        res = { ...again, usage: { inputTokens: res.usage.inputTokens + again.usage.inputTokens, outputTokens: res.usage.outputTokens + again.usage.outputTokens } };
        if (empty(res)) { state.emptyFinal = true; emit('assistant_model_empty_after_retry', { ms: Date.now() - t0 }); }
      }
      return res;
    },
  };

  const wrap = (t: ToolSpec): ToolSpec => {
    const read = t.read;
    if (!read) return t;
    return { ...t, read: async (ctx, args) => {
      const t0 = Date.now();
      try {
        return await read(ctx, args);
      } catch (err) {
        state.toolFailed = true;
        emit('assistant_tool_failed', { tool: t.name, error: err instanceof Error ? err.name : 'unknown', upstreamStatus: (err as { status?: number })?.status, ms: Date.now() - t0 });
        throw err;
      }
    } };
  };

  const wrapped: SmartLayerAdapter = {
    ...adapter,
    tools: () => adapter.tools().map(wrap),
    storage: { ...adapter.storage, appendAudit: async (r: AuditRow) => {
      emit('assistant_turn', { turnId: r.turnId, outcome: r.outcome, model: r.model, toolsOffered: r.toolsOffered.length, toolCalls: r.toolCalls, rails: r.rails, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      return adapter.storage.appendAudit(r);
    } },
  };

  return {
    requestId, adapter: wrapped, provider,
    refine(res, locale) {
      const only = res.segments.length === 1 && res.segments[0]!.kind === 'text' ? res.segments[0]!.text : null;
      if (only !== ENGINE_FALLBACK[locale]) return res;
      const m = state.toolFailed ? TOOL_FAILED : state.emptyFinal ? EMPTY_ANSWER : null;
      emit('assistant_fallback_reply', { reason: state.toolFailed ? 'tool_failed' : state.emptyFinal ? 'empty_model' : 'unknown', status: res.status });
      return m ? { ...res, status: 'limited', segments: [{ kind: 'text', text: m[locale] }] } : res;
    },
  };
}
