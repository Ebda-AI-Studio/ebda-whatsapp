import type { Env } from '../../env';
import { alert } from '../observability';
import { numberForDisplayPhone } from '../routing';
import { HEALTH_STATES, MEMBER_BLOCK_MS, SHARED_DOMINANCE, SHARED_SPIKE_MIN_MEMBERS, SPIKE_THRESHOLD, SPIKE_WINDOW_MS, mirrorHealth, nextHealth, sharedNumberByDisplay, signalSource, worsened, type HealthSignal, type HealthState } from './health';

/** Hands background work to the request's waitUntil (the webhook answers Meta once D1 is up to date, not after every member was told). */
export type Schedule = (work: () => Promise<unknown>) => void;
const detached: Schedule = (f) => { void f().catch(() => undefined); };
const MEMBER_CHUNK = 10;

/**
 * A quality signal for the number with this display phone. The PLATFORM number is checked first (it belongs to no workspace and its state lives on its own
 * D1 row; a stray `phone_numbers` row for it must never shadow that), then a store's own number (state machine, campaign pause, alerts in its workspace).
 * `at` is Meta's own time of the event (ms; 0 = unknown): an older signal retried later is dropped. Unknown numbers are ignored (still a 200: a 5xx only makes Meta repeat it).
 */
export async function applyHealthEvent(env: Env, wabaId: string, displayPhone: string, signal: HealthSignal, at = 0, schedule: Schedule = detached): Promise<void> {
  const when = at > 0 ? at : undefined; // no Meta time = a local signal: it never takes part in the ordering
  const shared = await sharedNumberByDisplay(env.DB, wabaId, displayPhone);
  if (shared) { await applySharedHealth(env, shared.phoneNumberId, signal, when, schedule); return; }
  const own = await numberForDisplayPhone(env.DB, wabaId, displayPhone);
  if (own) await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(own.workspaceId)).applyNumberHealth(own.phoneNumberId, signal, Date.now(), when);
}

/** `account_update` is WABA-wide: every active number on the WABA and every platform number on it. */
export async function applyAccountEvent(env: Env, wabaId: string, signal: HealthSignal, at = 0, schedule: Schedule = detached): Promise<void> {
  const when = at > 0 ? at : undefined;
  const sharedIds = new Set((await env.DB.prepare('SELECT phone_number_id FROM shared_numbers WHERE waba_id = ?').bind(wabaId).all<{ phone_number_id: string }>()).results.map((r) => r.phone_number_id));
  const { results } = await env.DB.prepare("SELECT phone_number_id, workspace_id FROM phone_numbers WHERE waba_id = ? AND status = 'active'").bind(wabaId).all<{ phone_number_id: string; workspace_id: string }>();
  for (const n of results) {
    if (sharedIds.has(n.phone_number_id)) continue; // the platform number is handled once, below
    await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(n.workspace_id)).applyNumberHealth(n.phone_number_id, signal, Date.now(), when);
  }
  for (const id of sharedIds) await applySharedHealth(env, id, signal, when, schedule);
}

/**
 * The platform number: ONE state machine on its D1 row (ordered by Meta's time), ONE alert at the platform level, then the new STATE (not the signal) is
 * pushed to every active member's own copy in the background. Members never alert for the shared number and never replay a signal: they are set to the
 * state, so a lost or reordered push is repaired by the next push, by a join, and by the daily reconcile.
 */
export async function applySharedHealth(env: Env, phoneNumberId: string, signal: HealthSignal, signalAt: number | undefined, schedule: Schedule = detached, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare('SELECT health_state, health_signal_at FROM shared_numbers WHERE phone_number_id = ?').bind(phoneNumberId).first<{ health_state: HealthState; health_signal_at: number }>();
  if (!row) return;
  const to = nextHealth(row.health_state, signal);
  // Ordering may only drop a stale RECOVERY: a signal that is older than the newest Meta-timed one AND would lower the state. A worsening signal always applies.
  if (signalAt !== undefined && signalAt < row.health_signal_at && HEALTH_STATES.indexOf(to) < HEALTH_STATES.indexOf(row.health_state)) return;
  await mirrorHealth(env.DB, 'shared_numbers', phoneNumberId, to, signalSource(signal), now, signalAt ?? 0); // only Meta-timed signals advance the ordering column
  const fields = { phoneNumberId, shared: true, from: row.health_state, to, source: signalSource(signal) };
  if (signal.kind === 'spike') alert('number_error_spike', fields);
  else if (worsened(row.health_state, to)) {
    if (to === 'yellow') alert('number_quality_flagged', fields);
    else alert('number_restricted', fields);
  }
  schedule(() => pushToMembers(env, phoneNumberId, to, now));
}

/**
 * Sets every active member's copy to this state, a few at a time (each is a Durable Object call). One member failing never stops the others.
 * `version` is the PROCESSING time of the state (the D1 row's `health_at`), not Meta's: two signals of the same second must still be applied in the order we
 * decided them, so a member ignores a push older than the newest one it has seen.
 */
export async function pushToMembers(env: Env, phoneNumberId: string, state: HealthState, version: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT workspace_id FROM shared_number_members WHERE phone_number_id = ? AND status = 'active'").bind(phoneNumberId).all<{ workspace_id: string }>();
  for (let i = 0; i < results.length; i += MEMBER_CHUNK) {
    await Promise.all(results.slice(i, i + MEMBER_CHUNK).map(async (m) => {
      try { await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(m.workspace_id)).syncSharedHealth(phoneNumberId, state, version); }
      catch { alert('shared_health_push_failed', { workspace: m.workspace_id, phoneNumberId }); }
    }));
  }
}

/** Brings ONE member's copy to the platform number's current D1 state: after a join or rejoin (its old copy may be stale, or the number may have changed mid-join). */
export async function syncMemberHealth(env: Env, workspaceId: string): Promise<void> {
  const num = await env.DB.prepare(
    "SELECT n.phone_number_id, n.health_state, coalesce(n.health_at, 0) AS health_at FROM shared_number_members m JOIN shared_numbers n ON n.phone_number_id = m.phone_number_id WHERE m.workspace_id = ? AND m.status = 'active'",
  ).bind(workspaceId).first<{ phone_number_id: string; health_state: HealthState; health_at: number }>();
  if (num) await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId)).syncSharedHealth(num.phone_number_id, num.health_state, num.health_at);
}

/** Daily: every platform number's D1 state is pushed to its members again (repairs any push that never arrived). */
export async function reconcileSharedHealth(env: Env): Promise<void> {
  const { results } = await env.DB.prepare('SELECT phone_number_id, health_state, coalesce(health_at, 0) AS health_at FROM shared_numbers').all<{ phone_number_id: string; health_state: HealthState; health_at: number }>();
  for (const n of results) await pushToMembers(env, n.phone_number_id, n.health_state, n.health_at);
}

export type SharedSpike = { kind: 'none' } | { kind: 'platform' } | { kind: 'member'; workspaceId: string } | { kind: 'ambiguous' };

/**
 * The platform number's spike guard, attributed per MEMBER (D1 `shared_number_errors`). Once the window holds SPIKE_THRESHOLD errors:
 *  - from at least SHARED_SPIKE_MIN_MEMBERS distinct members -> the number itself is in trouble: `platform` (the state trips for everyone);
 *  - else one member with at least SHARED_DOMINANCE of them -> `member`: only that store's template sends on the number stop;
 *  - else (two members, no clear culprit) -> `ambiguous`: alert only, nobody is stopped.
 * The counters are cleared on any verdict but `none`, so the next spike needs fresh errors.
 */
export async function noteSharedError(env: Env, phoneNumberId: string, workspaceId: string, now = Date.now()): Promise<SharedSpike> {
  const bucket = Math.floor(now / 600_000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shared_number_errors (phone_number_id, workspace_id, bucket, n) VALUES (?, ?, ?, 1) ON CONFLICT(phone_number_id, workspace_id, bucket) DO UPDATE SET n = n + 1').bind(phoneNumberId, workspaceId, bucket),
    env.DB.prepare('DELETE FROM shared_number_errors WHERE bucket < ?').bind(bucket - Math.ceil(SPIKE_WINDOW_MS / 600_000) - 1),
  ]);
  const { results } = await env.DB.prepare('SELECT workspace_id, sum(n) AS n FROM shared_number_errors WHERE phone_number_id = ? AND bucket > ? GROUP BY workspace_id ORDER BY n DESC')
    .bind(phoneNumberId, bucket - Math.ceil(SPIKE_WINDOW_MS / 600_000)).all<{ workspace_id: string; n: number }>();
  const total = results.reduce((a, r) => a + r.n, 0);
  if (total < SPIKE_THRESHOLD) return { kind: 'none' };
  await env.DB.prepare('DELETE FROM shared_number_errors WHERE phone_number_id = ?').bind(phoneNumberId).run();
  if (results.length >= SHARED_SPIKE_MIN_MEMBERS) return { kind: 'platform' };
  const top = results[0]!;
  return top.n / total >= SHARED_DOMINANCE ? { kind: 'member', workspaceId: top.workspace_id } : { kind: 'ambiguous' };
}

export { MEMBER_BLOCK_MS };
