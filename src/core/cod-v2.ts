import type { Env } from '../env';
import { alert } from './observability';
import type { TemplateSeedInput } from './templates-service';
import { deleteTemplate, installDefaults, syncTemplates, type TemplatesCtx } from './templates-service';

/** The brand's per-store template, registered once per isolate (the addon supplies it; core never imports a brand): origin in, Meta template out. */
export type PerStoreTemplate = { name: string; language: string; build(origin: string): TemplateSeedInput & { language: string } };
let perStore: PerStoreTemplate | null = null;
export function registerPerStoreTemplate(t: PerStoreTemplate | null): void {
  perStore = t;
}

/**
 * Per-store submission of the richer COD template (cod_confirmation_v2). Its URL button has a FIXED base and every store has its own
 * storefront origin, so it is submitted per workspace with the origin the Store told us (`store.linked.storefrontOrigin`). Never assumed
 * approved: the row starts PENDING and the sender uses it only once Meta says APPROVED. Idempotent: a template that already exists
 * (any status) is left alone, except a REJECTED one on an explicit resubmit, which is replaced.
 */
export type CodV2Outcome = 'submitted' | 'exists' | 'no_origin' | 'no_number' | 'shared_number' | 'failed';

/** The submission itself, given a context that already has the merchant's number. */
export async function submitCodV2(ctx: TemplatesCtx, opts: { resubmit?: boolean } = {}): Promise<CodV2Outcome> {
  if (!perStore) return 'no_origin';
  const origin = await ctx.ws.storeOrigin();
  if (!origin) return 'no_origin';
  const seed = perStore.build(origin);
  const synced = await syncTemplates(ctx); // what Meta already has is adopted, never resubmitted
  if (!synced.ok) return 'failed';
  const row = await ctx.ws.getTemplate(seed.name, seed.language);
  if (row && opts.resubmit && row.status === 'REJECTED') {
    const gone = await deleteTemplate(ctx, { name: seed.name, language: seed.language });
    if (!gone.ok) return 'failed';
  } else if (row) return 'exists';
  const out = await installDefaults(ctx, [seed]);
  if (!out.ok || out.failed.length > 0) return 'failed';
  return out.submitted.length > 0 ? 'submitted' : 'exists';
}

/** Looks up the workspace's own active number (the shared platform WABA is not a merchant's to fill) and submits. Never throws. */
export async function ensureCodV2(env: Env, workspaceId: string): Promise<CodV2Outcome> {
  try {
    const number = await env.DB.prepare("SELECT phone_number_id, waba_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid LIMIT 1").bind(workspaceId).first<{ phone_number_id: string; waba_id: string }>();
    if (!number) return 'no_number';
    if (await env.DB.prepare('SELECT 1 FROM shared_numbers WHERE waba_id = ?').bind(number.waba_id).first()) return 'shared_number';
    const ws = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
    const ctx: TemplatesCtx = { env, ws, workspaceId, number: { phoneNumberId: number.phone_number_id, wabaId: number.waba_id } };
    const r = await submitCodV2(ctx);
    if (r === 'failed') alert('cod_v2_submit_failed', { workspace: workspaceId, template: perStore?.name });
    return r;
  } catch (err) {
    alert('cod_v2_submit_failed', { workspace: workspaceId, template: perStore?.name, error: err instanceof Error ? err.name : 'error' });
    return 'failed';
  }
}
