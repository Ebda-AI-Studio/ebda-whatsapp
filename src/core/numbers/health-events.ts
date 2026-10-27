import type { Env } from '../../env';
import { alert } from '../observability';
import { numberForDisplayPhone } from '../routing';
import { mirrorHealth, nextHealth, sharedNumberByDisplay, signalSource, worsened, type HealthSignal } from './health';

/**
 * A quality signal for the number with this display phone: a store's own number goes to its workspace (state machine, campaign pause, alerts);
 * the platform (shared) number has no workspace, so its state is kept on its own D1 row and gates new members joining.
 * Unknown numbers are ignored (the webhook is still acknowledged: a 5xx would only make Meta repeat it).
 */
export async function applyHealthEvent(env: Env, wabaId: string, displayPhone: string, signal: HealthSignal): Promise<void> {
  const own = await numberForDisplayPhone(env.DB, wabaId, displayPhone);
  if (own) {
    await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(own.workspaceId)).applyNumberHealth(own.phoneNumberId, signal);
    return;
  }
  const shared = await sharedNumberByDisplay(env.DB, wabaId, displayPhone);
  if (shared) await applySharedHealth(env, shared.phoneNumberId, signal);
}

/** `account_update` is WABA-wide: every active number on the WABA and every platform number on it. */
export async function applyAccountEvent(env: Env, wabaId: string, signal: HealthSignal): Promise<void> {
  const { results } = await env.DB.prepare("SELECT phone_number_id, workspace_id FROM phone_numbers WHERE waba_id = ? AND status = 'active'").bind(wabaId).all<{ phone_number_id: string; workspace_id: string }>();
  for (const n of results) await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(n.workspace_id)).applyNumberHealth(n.phone_number_id, signal);
  const shared = await env.DB.prepare('SELECT phone_number_id FROM shared_numbers WHERE waba_id = ?').bind(wabaId).all<{ phone_number_id: string }>();
  for (const s of shared.results) await applySharedHealth(env, s.phone_number_id, signal);
}

async function applySharedHealth(env: Env, phoneNumberId: string, signal: HealthSignal, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare('SELECT health_state FROM shared_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first<{ health_state: Parameters<typeof nextHealth>[0] }>();
  if (!row) return;
  const to = nextHealth(row.health_state, signal);
  await mirrorHealth(env.DB, 'shared_numbers', phoneNumberId, to, signalSource(signal), now);
  // Push the same signal to EVERY active member's own copy, so the send gate (claimSend), campaign start and resume see it with no D1 read and no cache.
  // Always forwarded, also on a redelivery (idempotent), so a member that missed an earlier push is repaired by Meta's retry. A member only ever joins
  // while the number is green, so every member's machine starts where the number's did and the same signals keep them equal.
  const members = await env.DB.prepare("SELECT workspace_id FROM shared_number_members WHERE phone_number_id = ? AND status = 'active'").bind(phoneNumberId).all<{ workspace_id: string }>();
  for (const m of members.results) await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(m.workspace_id)).applyNumberHealth(phoneNumberId, signal, now);
  const fields = { phoneNumberId, shared: true, from: row.health_state, to, source: signalSource(signal) };
  if (worsened(row.health_state, to)) {
    if (to === 'yellow') alert('number_quality_flagged', fields);
    else alert('number_restricted', fields);
  }
}
