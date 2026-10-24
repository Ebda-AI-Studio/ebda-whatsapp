import { afterEach, beforeEach } from 'vitest';
import { agentConfig, configureAgent, type AgentConfig, type AgentCopy } from '../../src/core/ai/config';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse, type ToolCall } from '../../src/core/ai/provider';
import { EBDA_AGENT_COPY } from '../../src/addons/ebda/agent-copy';

export const TEST_SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

export type Step = { text?: string; tools?: { name: string; arguments?: unknown }[]; delayMs?: number; fail?: LlmError | Error; usage?: { inputTokens: number; outputTokens: number } };

/** A model that plays back a script, one step per call, and records every request. Tests never call a real model. */
export class ScriptedProvider implements LlmProvider {
  calls: LlmRequest[] = [];
  private n = 0;
  constructor(private readonly steps: Step[], readonly byoKey = false) {}
  get callCount() { return this.calls.length; }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(structuredClone(req));
    const step = this.steps[this.n++];
    if (!step) throw new Error('scripted provider: no step left');
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if (step.fail) throw step.fail;
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
