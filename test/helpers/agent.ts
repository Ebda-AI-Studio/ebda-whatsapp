import { afterEach, beforeEach } from 'vitest';
import { agentConfig, configureAgent, type AgentConfig, type AgentCopy } from '../../src/core/ai/config';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type ToolCall } from '../../src/core/ai/provider';
import { EBDA_AGENT_COPY } from '../../src/addons/ebda/agent-copy';

export const TEST_SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

export type Step = {
  text?: string; tools?: { name: string; arguments?: unknown }[]; delayMs?: number; fail?: LlmError | Error; usage?: { inputTokens: number; outputTokens: number };
  /** Called when the model receives this call; with `holdUntil`, lets a test act at a known point mid-call instead of guessing with a sleep. */
  onStart?: () => void;
  /**
   * The call does not answer until this returns true. Polled on the model's own timer: a promise resolved from the test would carry the
   * test's I/O context into the Durable Object (and back), which workerd refuses.
   */
  holdUntil?: () => boolean;
};

/** A model that plays back a script, one step per call, and records every request. Tests never call a real model. */
export class ScriptedProvider implements LlmProvider {
  calls: LlmRequest[] = [];
  /** Names of the tools this model asked for, in order. */
  emitted: string[] = [];
  private n = 0;
  constructor(private readonly steps: Step[], readonly byoKey = false) {}
  get callCount() { return this.calls.length; }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone(req));
    const step = this.steps[this.n++];
    if (!step) throw new Error('scripted provider: no step left');
    step.onStart?.();
    while (step.holdUntil && !step.holdUntil()) await new Promise((r) => setTimeout(r, 5));
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.fail) throw step.fail;
    this.emitted.push(...(step.tools ?? []).map((t) => t.name));
    const toolCalls: ToolCall[] | undefined = step.tools?.map((t, i) => ({ id: `call_${this.n}_${i}`, name: t.name, arguments: t.arguments ?? {} }));
    return { ...(step.text !== undefined ? { text: step.text } : {}), ...(toolCalls ? { toolCalls } : {}), usage: step.usage ?? { inputTokens: 10, outputTokens: 5 } };
  }
}

/** Registers the Ebda agent copy, the test secrets key and a scripted model (set `agent.model` per test) for each test of the file. */
export function useAgent(over: Partial<AgentConfig> = {}) {
  const ctx = { model: new ScriptedProvider([]) as LlmProvider, previous: undefined as AgentConfig | undefined };
  beforeEach(() => {
    ctx.model = new ScriptedProvider([]);
    ctx.previous = configureAgent({ copy: EBDA_AGENT_COPY as AgentCopy, secretsKey: () => TEST_SECRETS_KEY, provider: () => ctx.model, ...over });
  });
  afterEach(() => {
    if (ctx.previous) configureAgent(ctx.previous);
  });
  return ctx;
}
export { agentConfig };

// ---- knowledge base fakes ---------------------------------------------------------------------------------------------

import type { Embedder, VectorStore } from '../../src/core/ai/config';
import { normaliseText } from '../../src/core/text-normalise';

/** A bag-of-words embedding (hashed into 64 dimensions, unit length): texts sharing words are close, others are not. */
export const bagEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Array<number>(64).fill(0);
    for (const w of normaliseText(t).split(' ').filter((x) => x.length > 1)) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 64]! += 1;
    }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });

/** An in-memory vector index with namespaces; records every query. */
export class MemoryVectors implements VectorStore {
  data = new Map<string, Map<string, { values: number[]; metadata?: Record<string, string> }>>();
  queries: { namespace: string; topK: number }[] = [];
  deleted: string[] = [];
  upserts = 0;
  failUpserts = 0;
  async upsert(vectors: Parameters<VectorStore['upsert']>[0]) {
    if (this.failUpserts > 0) {
      this.failUpserts--;
      throw new Error('vector index down');
    }
    for (const v of vectors) {
      this.upserts++;
      if (!this.data.has(v.namespace)) this.data.set(v.namespace, new Map());
      this.data.get(v.namespace)!.set(v.id, { values: v.values, ...(v.metadata ? { metadata: v.metadata } : {}) });
    }
  }
  async query(values: number[], o: { namespace: string; topK: number }) {
    this.queries.push(o);
    const ns = this.data.get(o.namespace) ?? new Map();
    return [...ns.entries()]
      .map(([id, v]) => ({ id, score: v.values.reduce((s: number, x: number, i: number) => s + x * (values[i] ?? 0), 0), ...(v.metadata ? { metadata: v.metadata } : {}) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, o.topK);
  }
  async deleteByIds(ids: string[]) {
    this.deleted.push(...ids);
    for (const ns of this.data.values()) for (const id of ids) ns.delete(id);
  }
  all(ns: string) { return [...(this.data.get(ns)?.keys() ?? [])]; }
}

/** Waits (up to `ms`) for a condition; the DO alarm runs scheduled tasks on its own, so tests wait for outcomes instead of assuming who ran a task. */
export async function until(cond: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('until: condition not met in time');
}
