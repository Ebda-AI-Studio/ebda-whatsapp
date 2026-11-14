/**
 * Model routing: ids are CONFIGURATION, never literals in engine code (plan 4 Global Constraints). This table is the only place
 * model ids appear; `types.test.ts` scans the rest of the engine for `@cf/`.
 *
 * PROVISIONAL (ruling SL-MODEL-1 not written yet): the defaults are the deterministic leaders of the 2026-11-14 bake-off
 * (ebda-foundation pr 73, `evals/bakeoff/results/2026-11-14.md`). Human labels are still missing, so subjective quality is unmeasured.
 * Choices: answer + plan = glm-5.3 (answer 92%, plan 97%, run stability 93%; inkling-2-small ties on answer but had 46 transient errors and
 * 32% on confirm rows); template = gpt-oss-120b (87%); classify = gemma-4-26b-a4b (safety 100%, 0.25 USD per 1k turns; closest proxy, the
 * classifier job was not measured); judge = gpt-oss-120b (advisory only, SL-JUDGE-1). When SL-MODEL-1 lands, only this table changes.
 */
export type ModelRouting = { answer: string; plan: string; template: string; classify: string; judge: string; embed: string };

export const DEFAULT_MODELS: ModelRouting = {
  answer: '@cf/zai-org/glm-5.3',
  plan: '@cf/zai-org/glm-5.3',
  template: '@cf/openai/gpt-oss-120b',
  classify: '@cf/google/gemma-4-26b-a4b-it',
  judge: '@cf/openai/gpt-oss-120b',
  embed: '@cf/baai/bge-m3',
};
export const MODELS_PROVISIONAL = true;

export function resolveModels(overrides: Partial<ModelRouting> = {}): ModelRouting {
  const out: ModelRouting = { ...DEFAULT_MODELS };
  for (const k of Object.keys(DEFAULT_MODELS) as Array<keyof ModelRouting>) {
    const v = overrides[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}
