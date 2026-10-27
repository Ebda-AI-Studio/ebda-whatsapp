import type { Env } from '../../env';
import { alert } from '../observability';
import { numberForDisplayPhone } from '../routing';
import { HEALTH_STATES, MEMBER_BLOCK_MS, SHARED_DOMINANCE, SHARED_MEMBER_ERROR_RATE, SHARED_MEMBER_MIN_SENDS, SHARED_REPEAT_WINDOWS, SHARED_REPEAT_WINDOW_MS, SHARED_REST_THRESHOLD, SHARED_SPIKE_MIN_MEMBERS, SPIKE_THRESHOLD, SPIKE_WINDOW_MS, mirrorHealth, nextHealth, sharedNumberByDisplay, signalSource, worsened, type HealthSignal, type HealthState } from './health';

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

export type SharedSpike =
  | { kind: 'none' }
  | { kind: 'platform' }
  /** One store is to blame: its sends stop. `platform` is also true when the OTHER members' errors on their own meet the platform rule. */
  | { kind: 'member'; workspaceId: string; platform: boolean }
  | { kind: 'ambiguous' };

/** One send claimed by a member on the platform number: the denominator of its error rate. Counts only. */
export async function noteSharedSend(env: Env, phoneNumberId: string, workspaceId: string, now = Date.now()): Promise<void> {
  const bucket = Math.floor(now / 600_000);
  await env.DB.prepare('INSERT INTO shared_number_sends (phone_number_id, workspace_id, bucket, n) VALUES (?, ?, ?, 1) ON CONFLICT(phone_number_id, workspace_id, bucket) DO UPDATE SET n = n + 1').bind(phoneNumberId, workspaceId, bucket).run();
}

/**
 * The platform number's spike guard, attributed per MEMBER by its OWN error RATE (D1 `shared_number_errors` / `shared_number_sends`). Once the window holds SPIKE_THRESHOLD errors,
 * in this ORDER ("over the bar" = at least SHARED_MEMBER_MIN_SENDS sends and an error rate of at least SHARED_MEMBER_ERROR_RATE; no send data = not over the bar):
 *  1. DOMINANCE first: a member with at least SHARED_DOMINANCE of the window's errors AND over the rate bar is blocked; one under the bar earns a strike instead. Either way
 *     the platform verdict uses the REST ONLY: it trips if the OTHERS reach SHARED_REST_THRESHOLD errors from at least SHARED_SPIKE_MIN_MEMBERS members (a dominance-scaled
 *     bar: an abuser, or a big honest store, with two tiny accomplices does not take the number down);
 *  2. else errors from at least SHARED_SPIKE_MIN_MEMBERS distinct members -> the number itself: `platform`;
 *  3. else `ambiguous`: alert only, BUT every member over the rate bar (whatever its share) earns a strike, and SHARED_REPEAT_WINDOWS strikes inside SHARED_REPEAT_WINDOW_MS block
 *     it (a rolling tally; the window counters are cleared, the strikes are not).
 * A high-volume, low-rate store is never blocked on one window (a dominant one earns a strike). Errors and sends are cleared together on any verdict but `none`.
 */
export async function noteSharedError(env: Env, phoneNumberId: string, workspaceId: string, now = Date.now()): Promise<SharedSpike> {
  const bucket = Math.floor(now / 600_000);
  const oldest = bucket - Math.ceil(SPIKE_WINDOW_MS / 600_000);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shared_number_errors (phone_number_id, workspace_id, bucket, n) VALUES (?, ?, ?, 1) ON CONFLICT(phone_number_id, workspace_id, bucket) DO UPDATE SET n = n + 1').bind(phoneNumberId, workspaceId, bucket),
    env.DB.prepare('DELETE FROM shared_number_errors WHERE bucket < ?').bind(oldest - 1),
    env.DB.prepare('DELETE FROM shared_number_sends WHERE bucket < ?').bind(oldest - 1),
  ]);
  const { results } = await env.DB.prepare('SELECT workspace_id, sum(n) AS n FROM shared_number_errors WHERE phone_number_id = ? AND bucket > ? GROUP BY workspace_id ORDER BY n DESC').bind(phoneNumberId, oldest).all<{ workspace_id: string; n: number }>();
  const total = results.reduce((a, r) => a + r.n, 0);
  if (total < SPIKE_THRESHOLD) return { kind: 'none' };
  const sends = new Map((await env.DB.prepare('SELECT workspace_id, sum(n) AS n FROM shared_number_sends WHERE phone_number_id = ? AND bucket > ? GROUP BY workspace_id').bind(phoneNumberId, oldest).all<{ workspace_id: string; n: number }>()).results.map((r) => [r.workspace_id, r.n]));
  // Both windows are cleared together on any verdict: errors and the sends they are measured against always cover the same stretch of time.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_number_errors WHERE phone_number_id = ?').bind(phoneNumberId),
    env.DB.prepare('DELETE FROM shared_number_sends WHERE phone_number_id = ?').bind(phoneNumberId),
  ]);
  const overBar = (r: { workspace_id: string; n: number }): boolean => { const s = sends.get(r.workspace_id) ?? 0; return s >= SHARED_MEMBER_MIN_SENDS && r.n / s >= SHARED_MEMBER_ERROR_RATE; };
  const since = now - SHARED_REPEAT_WINDOW_MS;
  await env.DB.prepare('DELETE FROM shared_number_strikes WHERE at < ?').bind(since).run();
  /** A strike for `ws`; true once it has SHARED_REPEAT_WINDOWS of them inside the rolling window (then they are spent). */
  const strike = async (ws: string): Promise<boolean> => {
    await env.DB.prepare('INSERT INTO shared_number_strikes (phone_number_id, workspace_id, at) VALUES (?, ?, ?)').bind(phoneNumberId, ws, now).run();
    const n = (await env.DB.prepare('SELECT count(*) AS n FROM shared_number_strikes WHERE phone_number_id = ? AND workspace_id = ? AND at >= ?').bind(phoneNumberId, ws, since).first<{ n: number }>())?.n ?? 0;
    if (n < SHARED_REPEAT_WINDOWS) return false;
    await env.DB.prepare('DELETE FROM shared_number_strikes WHERE phone_number_id = ? AND workspace_id = ?').bind(phoneNumberId, ws).run();
    return true;
  };
  const top = results[0]!;
  if (top.n / total >= SHARED_DOMINANCE) {
    // 1. DOMINANCE first. The platform verdict then uses the REST ONLY: the dominant member's own errors never count toward tripping the number for everyone,
    //    whether or not it is blocked.
    const platform = results.length - 1 >= SHARED_SPIKE_MIN_MEMBERS && total - top.n >= SHARED_REST_THRESHOLD;
    // Over the rate bar: blocked at once. Under it (a big honest store): never blocked on one window, but it earns a strike, so repeated dominance still escalates.
    if (overBar(top) || (await strike(top.workspace_id))) return { kind: 'member', workspaceId: top.workspace_id, platform };
    return platform ? { kind: 'platform' } : { kind: 'ambiguous' };
  }
  if (results.length >= SHARED_SPIKE_MIN_MEMBERS) return { kind: 'platform' }; // 2.
  // 3. ambiguous: a member whose own rate is over the bar earns a strike, whatever its share
  for (const r of results) if (overBar(r) && (await strike(r.workspace_id))) return { kind: 'member', workspaceId: r.workspace_id, platform: false };
  return { kind: 'ambiguous' };
}

export { MEMBER_BLOCK_MS };
