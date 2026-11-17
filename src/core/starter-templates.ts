import type { Env } from '../env';
import { ensureCodV2 } from './cod-v2';
import { alert } from './observability';
import { installDefaults, syncTemplates, type TemplateSeedInput, type TemplatesCtx } from './templates-service';

/** The brand's starter set, registered once per isolate (the addon supplies it; core never imports a brand). */
let seeds: readonly TemplateSeedInput[] = [];
export function registerStarterSet(set: readonly TemplateSeedInput[]): void {
  seeds = set;
}
export function starterSet(): readonly TemplateSeedInput[] {
  return seeds;
}

/** DO `store_state` key that records the starter set is fully in place for one WABA. */
export const starterKey = (wabaId: string): string => `templates.starter:${wabaId}`;

/**
 * Runs after a merchant's OWN number connected (and again when a half-finished connect is resumed, so it is idempotent): sync Meta's templates FIRST
 * (what the merchant already has is adopted, never resubmitted), then submit only the missing starters. The marker is written only when nothing failed,
 * and a marked WABA is not touched again. Never throws into the connect; a failure raises `starter_templates_failed` and leaves the screen's
 * "install defaults" retry path. The platform WABA of the shared number is not a merchant's to fill.
 */
export async function installStarterOnConnect(env: Env, n: { workspaceId: string; wabaId: string }): Promise<'done' | 'partial' | 'skipped'> {
  try {
    if (seeds.length === 0) return 'skipped';
    if (await env.DB.prepare('SELECT 1 FROM shared_numbers WHERE waba_id = ?').bind(n.wabaId).first()) return 'skipped';
    const number = await env.DB.prepare("SELECT phone_number_id FROM phone_numbers WHERE workspace_id = ? AND waba_id = ? AND status = 'active' ORDER BY rowid LIMIT 1").bind(n.workspaceId, n.wabaId).first<{ phone_number_id: string }>();
    if (!number) return 'skipped';
    const ws = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(n.workspaceId));
    if (await ws.starterInstalled(n.wabaId)) return 'done';
    const ctx: TemplatesCtx = { env, ws, workspaceId: n.workspaceId, number: { phoneNumberId: number.phone_number_id, wabaId: n.wabaId } };
    const synced = await syncTemplates(ctx);
    if (!synced.ok) return failedStarter(n.workspaceId, synced.reason);
    const out = await installDefaults(ctx, seeds);
    if (!out.ok) return failedStarter(n.workspaceId, out.reason);
    if (out.failed.length > 0) return failedStarter(n.workspaceId, 'some_failed');
    await ws.markStarterInstalled(n.wabaId);
    await ensureCodV2(env, n.workspaceId); // the Store may have linked before this number connected (never throws)
    return 'done';
  } catch (err) {
    return failedStarter(n.workspaceId, err instanceof Error ? err.name : 'error');
  }
}

function failedStarter(workspaceId: string, why: string): 'partial' {
  alert('starter_templates_failed', { workspaceId, why });
  return 'partial';
}
