/**
 * How the AI agent is wired. The core never imports a product addon, so the entry point registers the customer-facing words
 * once (`configureAgent`) and tests register a scripted model the same way (as `configureStoreLink` does for the Store).
 */
import type { Env } from '../../env';
import type { Locale, Localised } from '../ordering/copy';
import { OpenAiCompatibleProvider, WorkersAiProvider, type LlmProvider } from './provider';

/** Words of the agent, supplied by the product addon. */
export type AgentCopy = {
  /** The system prompt: persona, language rule, how to use the tools, the knowledge base chunks. The core adds nothing to it. */
  systemPrompt: (a: { persona: string; language: 'ar' | 'en' | 'auto'; storeName: string | null; knowledge: string[]; tools: string[] }) => string;
  /** Used when the merchant wrote no persona. */
  defaultPersona: Localised;
  /** Matched against the normalised message (`normaliseText`): any hit sends the customer to a person without calling the model. */
  handoffPatterns: readonly RegExp[];
  t: {
    /** Quick acknowledgement before a slow answer. */
    ack: Localised;
    /** Told to the customer when the conversation goes to a person (asked for, the model could not help, no credits, misconfigured). */
    handoffAck: Localised;
    /** Voice notes, pictures, files: the agent reads text only. */
    textOnly: Localised;
  };
};

/** The vector index (Vectorize in production). Namespaced per workspace; ids are opaque. */
export interface VectorStore {
  upsert(vectors: { id: string; values: number[]; namespace: string; metadata?: Record<string, string> }[]): Promise<void>;
  query(values: number[], opts: { namespace: string; topK: number }): Promise<{ id: string; score: number; metadata?: Record<string, string> }[]>;
  deleteByIds(ids: string[]): Promise<void>;
}
/** Turns texts into vectors (Workers AI `@cf/baai/bge-m3` in production). */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export type AgentConfig = {
  /** The vector index, or null when none is bound: the agent then answers without a knowledge base. */
  vectors: (env: Env) => VectorStore | null;
  embedder: (env: Env) => Embedder | null;
  copy: AgentCopy | null;
  /** The model for a workspace, or null when none can be built (no AI binding, no key). Tests return a scripted fake. */
  provider: (env: Env, ws: { settings: { provider: 'workers-ai' | 'openai-compatible'; model: string | null; baseUrl: string | null }; apiKey: string | null }) => LlmProvider | null;
  /** Base64 of the 32-byte key that encrypts merchants' own model keys. */
  secretsKey: (env: Env) => string | undefined;
  /** Extra hosts (beyond the built-in provider list) a merchant may use as a model endpoint; set by the operator. */
  allowedHosts: (env: Env) => string[];
  /** An answer expected to take longer than this gets a quick acknowledgement first. */
  slowMs: number;
  /** Workers AI model used for the platform-funded agent. */
  defaultModel: (env: Env) => string;
};

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

let current: AgentConfig = {
  copy: null,
  vectors: (env) => {
    const v = env.VECTORIZE;
    if (!v) return null;
    return {
      upsert: async (vectors) => { await v.upsert(vectors); },
      query: async (values, o) => {
        const r = await v.query(values, { namespace: o.namespace, topK: o.topK, returnMetadata: 'all' });
        return r.matches.map((m) => ({ id: m.id, score: m.score, ...(m.metadata ? { metadata: Object.fromEntries(Object.entries(m.metadata).map(([k, x]) => [k, String(x)])) } : {}) }));
      },
      deleteByIds: async (ids) => { await v.deleteByIds(ids); },
    };
  },
  embedder: (env) => {
    const ai = env.AI;
    if (!ai) return null;
    return async (texts) => {
      const out = (await ai.run(EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
      if (!out.data || out.data.length !== texts.length) throw new Error('embedding answer malformed');
      return out.data;
    };
  },
  provider: (env, ws) => {
    if (ws.settings.provider === 'openai-compatible') {
      return ws.settings.baseUrl && ws.settings.model && ws.apiKey ? new OpenAiCompatibleProvider({ baseUrl: ws.settings.baseUrl, apiKey: ws.apiKey, model: ws.settings.model }) : null;
    }
    return env.AI ? new WorkersAiProvider(env.AI, current.defaultModel(env)) : null;
  },
  secretsKey: (env) => env.AGENT_SECRETS_KEY,
  allowedHosts: (env) => (env.AGENT_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  slowMs: 2000,
  defaultModel: (env) => env.AGENT_MODEL || DEFAULT_WORKERS_AI_MODEL,
};

export function configureAgent(next: Partial<AgentConfig>): AgentConfig {
  const previous = current;
  current = { ...current, ...next };
  return previous;
}
export const agentConfig = (): AgentConfig => current;
export type { Locale };
