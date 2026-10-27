/**
 * Number health (W2-META). One small state machine per phone number, fed by Meta's `phone_number_quality_update` and `account_update`
 * webhooks, a rating refresh and the spike guard:
 *
 *   any    --FLAGGED / rating RED-->                 red        (a quality event never LOWERS red or restricted)
 *   green  --DOWNGRADE / rating YELLOW / spike-->    yellow
 *   any    --restriction / ban / violation-->        restricted (beats everything)
 *   restricted --restriction lifted-->               yellow     (never straight to green)
 *   yellow|red --UNFLAGGED / GREEN rating-->         green      (UPGRADE only lifts yellow)
 *
 * What each state does (applied in the workspace Durable Object, src/core/workspace-do.ts):
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

const rank = (s: HealthState): number => HEALTH_STATES.indexOf(s);
const worse = (a: HealthState, b: HealthState): HealthState => (rank(b) > rank(a) ? b : a);

/**
 * FAIL CLOSED: a quality event only ever holds or raises the state. The only ways down are the explicit recovery signals: UNFLAGGED, a GREEN rating read,
 * UPGRADE out of yellow, and (restricted only) Meta lifting the restriction, which lands on yellow. FLAGGED is treated as RED: Meta says the number's quality
 * is poor enough to be flagged, so campaigns pause AND new templates stop until Meta says it recovered. INFERRED from Meta's documentation, not seen live.
 */
export function nextHealth(current: HealthState, signal: HealthSignal): HealthState {
  switch (signal.kind) {
    case 'restricted': return 'restricted';
    case 'restriction_lifted': return current === 'restricted' ? 'yellow' : current;
    case 'spike': return worse(current, 'yellow');
    case 'quality': {
      switch (signal.event.toUpperCase()) {
        case 'FLAGGED': return worse(current, 'red');
        case 'DOWNGRADE': return worse(current, 'yellow');
        case 'UNFLAGGED': return current === 'restricted' ? current : 'green';
        case 'UPGRADE': return current === 'yellow' ? 'green' : current;
        default: return current; // ONBOARDING and anything unknown
      }
    }
    case 'rating': {
      switch (signal.rating.toUpperCase()) {
        case 'RED': return worse(current, 'red');
        case 'YELLOW': return worse(current, 'yellow');
        case 'GREEN': return current === 'restricted' ? current : 'green';
        default: return current;
      }
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

/** When (Meta's time, ms) the newest signal applied to this number happened; 0 = none yet. */
export function lastSignalAt(sql: SqlStorage, phoneNumberId: string): number {
  return sql.exec<{ signal_at: number }>('SELECT signal_at FROM number_health_signal WHERE phone_number_id = ?', phoneNumberId).toArray()[0]?.signal_at ?? 0;
}
export function recordSignalAt(sql: SqlStorage, phoneNumberId: string, at: number): void {
  sql.exec('INSERT INTO number_health_signal (phone_number_id, signal_at) VALUES (?, ?) ON CONFLICT(phone_number_id) DO UPDATE SET signal_at = max(signal_at, excluded.signal_at)', phoneNumberId, at);
}

/** Meta errors that signal a sender-quality problem: 131049 (marketing frequency cap) and 131026 (undeliverable: blocked / not on WhatsApp). */
export const QUALITY_ERROR_CODES: ReadonlySet<number> = new Set([131049, 131026]);
/** This many quality errors on one number inside the window pause its campaigns (A5). A fixed threshold: it does not scale with the tier (documented residual). */
export const SPIKE_THRESHOLD = 25;
export const SPIKE_WINDOW_MS = 60 * 60_000;
/** The platform number is shared by strangers: its state trips (for every member) only when the errors come from at least this many DISTINCT members. */
export const SHARED_SPIKE_MIN_MEMBERS = 3;
/** Below that, one member that produced at least this share of the window's errors is the problem: only ITS template sends on the number stop. */
export const SHARED_DOMINANCE = 0.8;
/** How long a dominant member's template sends on the platform number stay stopped (it can be shortened by the operator evicting it). */
export const MEMBER_BLOCK_MS = 24 * 60 * 60_000;
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

const BLOCK_PREFIX = 'shared.blocked:';
/** Until when (epoch ms) this workspace's template sends on the platform number `pn` are stopped because it dominated a spike; 0 = not blocked. */
export function memberBlockedUntil(sql: SqlStorage, pn: string): number {
  return Number(sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', BLOCK_PREFIX + pn).toArray()[0]?.value ?? 0);
}
export function blockMember(sql: SqlStorage, pn: string, until: number): void {
  sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', BLOCK_PREFIX + pn, String(until));
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
export async function mirrorHealth(db: D1Database, table: 'phone_numbers' | 'shared_numbers', phoneNumberId: string, state: HealthState, reason: string, now: number, signalAt = 0): Promise<void> {
  await db.prepare(`UPDATE ${table} SET health_state = ?, health_reason = ?, health_at = ?, health_signal_at = max(health_signal_at, ?) WHERE phone_number_id = ? AND (health_state <> ? OR health_reason IS NOT ? OR health_signal_at < ?)`).bind(state, reason, now, signalAt, phoneNumberId, state, reason, signalAt).run();
}

export async function sharedNumberByDisplay(db: D1Database, wabaId: string, displayPhone: string): Promise<{ phoneNumberId: string; state: HealthState } | null> {
  const want = displayPhone.replace(/\D/g, '');
  const { results } = await db.prepare('SELECT phone_number_id, display_phone, health_state FROM shared_numbers WHERE waba_id = ? AND display_phone IS NOT NULL').bind(wabaId).all<{ phone_number_id: string; display_phone: string; health_state: HealthState }>();
  const hit = results.find((r) => r.display_phone.replace(/\D/g, '') === want);
  return hit ? { phoneNumberId: hit.phone_number_id, state: hit.health_state } : null;
}
