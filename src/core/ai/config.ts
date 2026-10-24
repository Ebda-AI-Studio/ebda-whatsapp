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

export type AgentConfig = {
  copy: AgentCopy | null;
  /** The model for a workspace, or null when none can be built (no AI binding, no key). Tests return a scripted fake. */
  provider: (env: Env, ws: { settings: { provider: 'workers-ai' | 'openai-compatible'; model: string | null; baseUrl: string | null }; apiKey: string | null }) => LlmProvider | null;
  /** Base64 of the 32-byte key that encrypts merchants' own model keys. */
  secretsKey: (env: Env) => string | undefined;
  /** An answer expected to take longer than this gets a quick acknowledgement first. */
  slowMs: number;
  /** Workers AI model used for the platform-funded agent. */
  defaultModel: (env: Env) => string;
};

export const DEFAULT_WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

let current: AgentConfig = {
  copy: null,
  provider: (env, ws) => {
    if (ws.settings.provider === 'openai-compatible') {
      return ws.settings.baseUrl && ws.settings.model && ws.apiKey ? new OpenAiCompatibleProvider({ baseUrl: ws.settings.baseUrl, apiKey: ws.apiKey, model: ws.settings.model }) : null;
    }
    return env.AI ? new WorkersAiProvider(env.AI, current.defaultModel(env)) : null;
  },
  secretsKey: (env) => env.AGENT_SECRETS_KEY,
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
