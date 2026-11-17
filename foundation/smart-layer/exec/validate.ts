/**
 * Execution rail 7: argument + existence/ownership validation (plan 4 Task B1). The model's arguments are parsed by the tool's schema
 * first; only the PARSED value is then checked: every id the model named must exist in THIS store (the adapter's `checkRefs` runs
 * under the merchant's tenant context), so a hallucinated id or another store's id never reaches `preview`. Error text returned to the
 * model lists paths and kinds only, never values (a value can be injected text or another tenant's id).
 */
import type { SmartLayerAdapter, ToolSpec, TurnCtx } from '../types';

export const MAX_REFS = 50;
export type ValidateResult = { ok: true; args: unknown } | { ok: false; error: 'invalid_args' | 'unknown_ref'; detail: string };

export async function validateCall(a: Pick<SmartLayerAdapter, 'checkRefs'>, ctx: TurnCtx, tool: ToolSpec, rawArgs: unknown): Promise<ValidateResult> {
  const parsed = tool.args.safeParse(rawArgs);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.') || '(root)'))];
    return { ok: false, error: 'invalid_args', detail: `invalid arguments at: ${paths.join(', ')}` };
  }
  let refs;
  try {
    refs = tool.refs ? tool.refs(parsed.data) : [];
  } catch {
    return { ok: false, error: 'invalid_args', detail: 'arguments could not be read' };
  }
  if (refs.length > MAX_REFS) return { ok: false, error: 'invalid_args', detail: `too many references (max ${MAX_REFS})` };
  if (refs.length) {
    let missing;
    try {
      missing = (await a.checkRefs(ctx, refs)).missing;
    } catch {
      return { ok: false, error: 'unknown_ref', detail: 'references could not be verified' }; // fail closed
    }
    if (missing.length) {
      const kinds = [...new Set(missing.map((m) => m.kind))];
      return { ok: false, error: 'unknown_ref', detail: `${missing.length} referenced ${kinds.join('/')} not found in this store` };
    }
  }
  return { ok: true, args: parsed.data };
}
