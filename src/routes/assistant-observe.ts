/**
 * Observability for one assistant turn (WA-ASSIST-OBS-1). The engine (`foundation/smart-layer/loop.ts`, vendored, not editable here) swallows every model, tool and rail
 * failure into a fixed reply, so a broken tool and a model that returned nothing looked the same in production: a 200 saying "I could not answer just now" and nothing in the logs.
 * This module wraps the three seams Chat owns (model provider, tool reads, audit write) so each failure leaves one JSON log line carrying the request id, and so
 * an empty model completion is retried once and, if it stays empty, is told to the merchant as what it is. Logs carry names, kinds, counts and timings: never a prompt, a reply or a secret.
 */
import { LlmError, WorkersAiProvider, type LlmProvider, type LlmRequest, type LlmResponse } from '../../foundation/smart-layer/provider';
import { foldArabic } from '../../foundation/text';
import type { AuditRow, Segment, SmartLayerAdapter, ToolSpec } from '../../foundation/smart-layer/types';

type L = { ar: string; en: string };
/** The engine's own provider-failure sentence (loop.ts MSG.providerFail): the reply the merchant got when nothing real was produced. */
export const ENGINE_FALLBACK: L = { ar: 'مقدرتش أرد دلوقتي. جرّب تاني بعد لحظة.', en: 'I could not answer just now. Please try again in a moment.' };
export const TOOL_FAILED: L = { ar: 'مقدرتش أقرا بيانات متجرك دلوقتي. جرّب تاني بعد لحظة.', en: 'I could not read your store data right now. Please try again in a moment.' };
export const EMPTY_ANSWER: L = { ar: 'الرد جه فاضي من المساعد. جرّب تسأل بصيغة تانية أو ابعت السؤال تاني.', en: 'The assistant came back with an empty answer. Try rephrasing, or send the question again.' };

/** Chat has no store-wide orders-count / sales-total / revenue tool (those live in the store's own dashboard); best sellers ARE a tool (`store_top_products`). Asking for the missing ones must never produce a number the model made up. */
export const NO_STORE_METRICS: L = { ar: 'مفيش عندي أداة لسه بتجيب عدد الطلبات أو المبيعات للمتجر كله. شوف الأرقام دي من لوحة تحكم المتجر.', en: 'I do not have a tool yet that reads your store-wide orders or sales. Please check those numbers in your store dashboard.' };
const METRIC = /(طلب|طلبات|اوردر|مبيع|ايراد|ارباح|ربح|orders?|sales|revenue|income|profit)/i;
const PERIOD = /(النهارد|اليوم|امبارح|الاسبوع|الشهر|السنه|today|yesterday|this week|this month|this year|last week|last month)/i;
const COUNT = /(كام|عدد|اجمال|مجموع|how many|how much|total|number of)/i;
/** "Which product sells most / the top sellers ...": answered by `store_top_products`, so it is NOT a question without a tool (a superlative on products or on what sells; "how many orders" has none). */
const TOP_SELLERS = /(اكتر|اكثر|اعلي|افضل|top|best|most)[^.?!]{0,30}(منتج|صنف|بيتباع|بتتباع|اتباع|مبيعا|seller|selling|products?|items?|sold)|(بيتباع|بتتباع|best.?sell|top.?sell)/i;
export const isTopSellersQuestion = (q: string): boolean => TOP_SELLERS.test(foldArabic(q));
/** "How many orders / how much in sales ... today": a store-wide figure Chat has no tool for. (A question naming a customer is the customer-orders tool's, and has no count word; a best-sellers question has its own tool.) */
export const isStoreMetricQuestion = (q: string): boolean => { const f = foldArabic(q); return METRIC.test(f) && PERIOD.test(f) && COUNT.test(f) && !isTopSellersQuestion(q); };

// Arabic-Indic (U+0660-0669) and Persian (U+06F0-06F9) digits are written as escapes (DIGITS-1): this is the INPUT side, it must recognise what a model may print.
const DIGITS = /[0-9\u0660-\u0669\u06F0-\u06F9]+(?:[.,][0-9\u0660-\u0669\u06F0-\u06F9]+)?/g;
const ASCII_DIGITS = (x: string): string => x.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf));
/** "5,400" and "5400" are the same figure: a thousands separator (a comma before exactly three digits) never makes a returned number look invented. */
const PLAIN = (x: string): string => x.replace(/(?<=\d),(?=\d{3}(?!\d))/g, '');

/**
 * GLM-5.3 cannot switch reasoning off (levels max | high | low, default max). Live 2026-11-23: with 15 tools offered the model spent the whole 700-token output budget on reasoning
 * and returned no content and no tool call (assistant_model_empty: outputTokens 700 = maxTokens 700, and again 1400 = 1400 on the retry), so a question that needs a tool read came back empty.
 * The engine does not set the field, so Chat's binding adds the lowest level for GLM models.
 */
export const withLowReasoning = (ai: SmartLayerAdapter['ai']): SmartLayerAdapter['ai'] => ({
  run: (model, inputs) => ai.run(model, /glm/i.test(model) && inputs.reasoning_effort === undefined ? { ...inputs, reasoning_effort: 'low' } : inputs),
});

/**
 * A [[cap:...]] / [[help:...]] marker is drawn as a button that carries its OWN title, right where the marker stands. Written inside a sentence it reads as a broken one
 * ("... تفاصيل النقل [نقل الرقم أو تغييره]", live 2026-11-24). The engine prompt (vendored) does not say how to place it, so Chat appends this rule to every model request.
 */
export const CHIP_RULE = '- A [[cap:...]] or [[help:...]] marker is shown to the merchant as a button with its own title. Put it as a standalone pointer: end a line with "شوف: [[cap:...]]" (English: "See: [[cap:...]]"), or list pointers at the end under "روابط مفيدة:" ("Useful links:"). Never use it as a word inside a sentence, and never repeat its title in your own words next to it.';

export type TurnObserver = {
  requestId: string;
  adapter: SmartLayerAdapter;
  provider: LlmProvider;
  /** A model-free provider for a question Chat has no tool for: the turn still runs every rail, quota and audit step, but the reply is the fixed honest text. */
  deterministic(question: string, locale: 'ar' | 'en'): LlmProvider | null;
  /** Swaps the engine's generic fallback for the specific reason, when there is one. */
  refine<T extends { status: string; segments: Segment[] }>(res: T, locale: 'ar' | 'en', question?: string): T;
};

export function observeTurn(adapter: SmartLayerAdapter, o: { storeId: string; log?: (line: Record<string, unknown>) => void }): TurnObserver {
  const requestId = crypto.randomUUID();
  const log = o.log ?? ((line) => console.log(JSON.stringify(line)));
  const emit = (event: string, f: Record<string, unknown>) => log({ event, requestId, storeId: o.storeId, ...f });
  const state = { toolFailed: false, emptyFinal: false, toolOut: [] as string[] };

  const inner = new WorkersAiProvider(withLowReasoning(adapter.ai), adapter.models.answer);
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
      req = { ...req, system: req.system.includes(CHIP_RULE) ? req.system : `${req.system}\n${CHIP_RULE}` };
      let res = await run(req);
      const empty = (x: LlmResponse) => !x.text && !x.toolCalls?.length;
      if (empty(res)) {
        // A reasoning model can spend the whole output budget on thinking and return no content. One retry with the SAME request (same tools, so it can still read real data and
        // never has to guess a figure) and a bigger output budget.
        emit('assistant_model_empty', { model: req.model ?? adapter.models.answer, outputTokens: res.usage.outputTokens, maxTokens: req.maxTokens, ms: Date.now() - t0 });
        const again = await run({ ...req, maxTokens: Math.min(req.maxTokens * 2, 4096) });
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
        const out = await read(ctx, args);
        state.toolOut.push(JSON.stringify(out) ?? '');
        return out;
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
    deterministic(question, locale) {
      if (!isStoreMetricQuestion(question)) return null;
      emit('assistant_store_metric_deterministic', {});
      return { byoKey: false, complete: async () => ({ text: NO_STORE_METRICS[locale], usage: { inputTokens: 0, outputTokens: 0 } }) };
    },
    refine(res, locale, question) {
      // A store-wide orders / sales question with a reply that states a figure no tool returned: the figure is invented, so the honest answer replaces it.
      if (question && METRIC.test(question) && PERIOD.test(question)) {
        const said = res.segments.map((x) => (x.kind === 'text' ? x.text : '')).join(' ');
        const real = PLAIN(ASCII_DIGITS(state.toolOut.join(' ')));
        const invented = (said.match(DIGITS) ?? []).map((n) => PLAIN(ASCII_DIGITS(n))).filter((n) => !real.includes(n));
        if (invented.length) {
          emit('assistant_invented_figure_removed', { count: invented.length });
          return { ...res, status: 'answered', segments: [{ kind: 'text', text: NO_STORE_METRICS[locale] }] };
        }
      }
      const only = res.segments.length === 1 && res.segments[0]!.kind === 'text' ? res.segments[0]!.text : null;
      if (only !== ENGINE_FALLBACK[locale]) return res;
      const m = state.toolFailed ? TOOL_FAILED : state.emptyFinal ? EMPTY_ANSWER : null;
      emit('assistant_fallback_reply', { reason: state.toolFailed ? 'tool_failed' : state.emptyFinal ? 'empty_model' : 'unknown', status: res.status });
      return m ? { ...res, status: 'limited', segments: [{ kind: 'text', text: m[locale] }] } : res;
    },
  };
}
