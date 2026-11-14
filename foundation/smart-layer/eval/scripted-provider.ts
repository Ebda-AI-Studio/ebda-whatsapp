/** A fake `LlmProvider` for tests and evals: replays a script and records every request it was sent (deep-copied, so later mutation cannot hide a leak). */
import type { LlmProvider, LlmRequest, LlmResponse } from '../provider';

export type ScriptStep = LlmResponse | ((req: LlmRequest) => LlmResponse);

export function scriptedProvider(script: ScriptStep[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let i = 0;
  return {
    byoKey: false,
    requests,
    async complete(req) {
      requests.push(JSON.parse(JSON.stringify(req)) as LlmRequest);
      const step = script[i++];
      if (!step) throw new Error(`scriptedProvider: no scripted response for call ${i}`);
      return typeof step === 'function' ? step(req) : step;
    },
  };
}
export const say = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): LlmResponse => ({ text, usage });
export const call = (name: string, args: unknown, id = `c_${name}`, usage = { inputTokens: 10, outputTokens: 5 }): LlmResponse => ({ toolCalls: [{ id, name, arguments: args }], usage });
