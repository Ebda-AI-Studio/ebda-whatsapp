/**
 * Number health (W2-META). One small state machine per phone number, fed by Meta's `phone_number_quality_update` and `account_update`
 * webhooks, a rating refresh and the spike guard:
 *
 *   green  --FLAGGED / YELLOW / DOWNGRADE / spike-->  yellow  --RED-->  red        (RESTRICTED beats all three)
 *   any    --restriction / ban / violation-->         restricted
 *   restricted --restriction lifted-->                yellow   (never straight to green: the next UNFLAGGED / UPGRADE / GREEN does that)
 *   yellow|red --UNFLAGGED / UPGRADE / GREEN-->       green    (yellow --YELLOW--> yellow, red --YELLOW--> yellow)
 *
 * What each state does (enforced in the workspace Durable Object, src/core/workspace-do.ts):
 *   yellow     running and scheduled campaigns on the number are paused (`quality_flagged`); P1 `number_quality_flagged`
 *   red / restricted   the same, and no new business-initiated TEMPLATE send leaves the number (service replies inside the 24 h window still go); P0 `number_restricted`
 *   recovery   NEVER resumes a campaign: the merchant does
 * Health is a NEVER-stale gate: every write goes to D1 (phone_numbers / shared_numbers) AND the workspace's own log; nothing caches it.
 */

export const HEALTH_STATES = ['green', 'yellow', 'red', 'restricted'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export type HealthSignal =
  | { kind: 'quality'; event: string }
  | { kind: 'rating'; rating: string }
  | { kind: 'restricted' }
  | { kind: 'restriction_lifted' }
  | { kind: 'spike' };

type Level = 'green' | 'yellow' | 'red';

/** Meta's `event` of a quality update. ONBOARDING and anything unknown change nothing. */
function levelOfEvent(event: string): Level | null {
  switch (event.toUpperCase()) {
    case 'FLAGGED': case 'DOWNGRADE': return 'yellow';
    case 'UNFLAGGED': case 'UPGRADE': return 'green';
    default: return null;
  }
}
function levelOfRating(rating: string): Level | null {
  switch (rating.toUpperCase()) {
    case 'GREEN': return 'green';
    case 'YELLOW': return 'yellow';
    case 'RED': return 'red';
    default: return null;
  }
}

export function nextHealth(current: HealthState, signal: HealthSignal): HealthState {
  switch (signal.kind) {
    case 'restricted': return 'restricted';
    case 'restriction_lifted': return current === 'restricted' ? 'yellow' : current;
    case 'spike': return current === 'green' ? 'yellow' : current;
    case 'quality': case 'rating': {
      const level = signal.kind === 'quality' ? levelOfEvent(signal.event) : levelOfRating(signal.rating);
      if (level === null || current === 'restricted') return current; // a restriction is only lifted by Meta saying so
      return level;
    }
  }
}

/** Worse than before: the moment campaigns are paused and a human is told. */
export const worsened = (from: HealthState, to: HealthState): boolean => HEALTH_STATES.indexOf(to) > HEALTH_STATES.indexOf(from);
/** red / restricted: no new business-initiated template leaves the number. */
export const blocksTemplates = (s: HealthState): boolean => s === 'red' || s === 'restricted';
export const signalSource = (s: HealthSignal): string => (s.kind === 'quality' ? `quality:${s.event.toUpperCase()}` : s.kind === 'rating' ? `rating:${s.rating.toUpperCase()}` : s.kind);

// ---- the workspace's own copy (Durable Object SQLite) ---------------------------------------------------------------------

export function currentHealth(sql: SqlStorage, phoneNumberId: string): HealthState {
  const row = sql.exec<{ to_state: HealthState }>('SELECT to_state FROM number_health_log WHERE phone_number_id = ? ORDER BY id DESC LIMIT 1', phoneNumberId).toArray()[0];
  return row?.to_state ?? 'green';
}
export function logHealth(sql: SqlStorage, phoneNumberId: string, from: HealthState, to: HealthState, source: string, detail: string | null, now: number): void {
  sql.exec('INSERT INTO number_health_log (phone_number_id, at, from_state, to_state, source, detail) VALUES (?, ?, ?, ?, ?, ?)', phoneNumberId, now, from, to, source, detail);
}

/** Meta errors that signal a sender-quality problem: 131049 (marketing frequency cap) and 131026 (undeliverable: blocked / not on WhatsApp). */
export const QUALITY_ERROR_CODES: ReadonlySet<number> = new Set([131049, 131026]);
/** This many quality errors on one number inside the window pause its campaigns (A5). A fixed threshold: it does not scale with the tier (documented residual). */
export const SPIKE_THRESHOLD = 25;
export const SPIKE_WINDOW_MS = 60 * 60_000;
const BUCKET_MS = 10 * 60_000;

/** Counts one quality error; true when the window now holds SPIKE_THRESHOLD or more (the counters are cleared so the next spike needs a fresh N). */
export function noteQualityError(sql: SqlStorage, phoneNumberId: string, now: number): boolean {
  const bucket = Math.floor(now / BUCKET_MS);
  sql.exec('INSERT INTO number_health_events (phone_number_id, bucket, n) VALUES (?, ?, 1) ON CONFLICT(phone_number_id, bucket) DO UPDATE SET n = n + 1', phoneNumberId, bucket);
  sql.exec('DELETE FROM number_health_events WHERE bucket < ?', bucket - Math.ceil(SPIKE_WINDOW_MS / BUCKET_MS) - 1);
  const total = sql.exec<{ n: number | null }>('SELECT sum(n) AS n FROM number_health_events WHERE phone_number_id = ? AND bucket > ?', phoneNumberId, bucket - Math.ceil(SPIKE_WINDOW_MS / BUCKET_MS)).one().n ?? 0;
  if (total < SPIKE_THRESHOLD) return false;
  sql.exec('DELETE FROM number_health_events WHERE phone_number_id = ?', phoneNumberId);
  return true;
}

const SUSPENDED_KEY = 'ops.suspended';
/** The workspace's own copy of the operator suspension (the Worker checks D1 first; the Durable Object checks this for the sends that never pass the Worker). */
export function isSuspended(sql: SqlStorage): boolean {
  return sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', SUSPENDED_KEY).toArray().length > 0;
}
export function setSuspendedFlag(sql: SqlStorage, suspended: boolean, reason: string): void {
  if (suspended) sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', SUSPENDED_KEY, reason.slice(0, 200));
  else sql.exec('DELETE FROM store_state WHERE key = ?', SUSPENDED_KEY);
}

// ---- D1 (what the Worker, the Numbers screen and the shared-number join read) -----------------------------------------------

/** Writes the state next to the number. Awaited by the writer: if D1 fails the webhook answers 5xx and Meta redelivers (the transition is idempotent). */
export async function mirrorHealth(db: D1Database, table: 'phone_numbers' | 'shared_numbers', phoneNumberId: string, state: HealthState, reason: string, now: number): Promise<void> {
  await db.prepare(`UPDATE ${table} SET health_state = ?, health_reason = ?, health_at = ? WHERE phone_number_id = ? AND (health_state <> ? OR health_reason IS NOT ?)`).bind(state, reason, now, phoneNumberId, state, reason).run();
}

export async function sharedNumberByDisplay(db: D1Database, wabaId: string, displayPhone: string): Promise<{ phoneNumberId: string; state: HealthState } | null> {
  const want = displayPhone.replace(/\D/g, '');
  const { results } = await db.prepare('SELECT phone_number_id, display_phone, health_state FROM shared_numbers WHERE waba_id = ? AND display_phone IS NOT NULL').bind(wabaId).all<{ phone_number_id: string; display_phone: string; health_state: HealthState }>();
  const hit = results.find((r) => r.display_phone.replace(/\D/g, '') === want);
  return hit ? { phoneNumberId: hit.phone_number_id, state: hit.health_state } : null;
}
