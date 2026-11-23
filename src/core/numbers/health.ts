import { isStandaloneId } from '../workspace-kind';
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
/**
 * A member is only ever blamed for its OWN error RATE (errors / messages it sent on the number in the same window), never for its share of the errors: a big honest sender
 * has many errors in absolute terms and a low rate, and another member could otherwise choose when the window closes. The bar: at least this rate over at least this many sends.
 */
export const SHARED_MEMBER_ERROR_RATE = 0.15;
export const SHARED_MEMBER_MIN_SENDS = 20;
/** In an ambiguous window (no one dominant, fewer than 3 members) a member over the rate bar earns a strike; this many strikes inside the window block it like a dominant one. */
export const SHARED_REPEAT_WINDOWS = 3;
export const SHARED_REPEAT_WINDOW_MS = 24 * 60 * 60_000;
/** When one member dominates, the platform still trips if the OTHERS reach the dominance-scaled share of the threshold, from at least SHARED_SPIKE_MIN_MEMBERS members. */
export const SHARED_REST_THRESHOLD = Math.ceil(Math.round(SPIKE_THRESHOLD * (1 - SHARED_DOMINANCE) * 1e6) / 1e6);
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
/** The Store's hold (STORE-STANDING-1): present while the linked Store store is suspended or deleted; value = `store_suspended:<reason>` / `store_deleted`. */
const STORE_HOLD_KEY = 'store.hold';
/** The wallet debt hold (WA-DEBT-1): present while the wallet debt is past twice the overdraft limit. Its OWN flag, so a top-up lifts only this one. */
const DEBT_HOLD_KEY = 'billing.debt_hold';
/**
 * May this workspace spend? False while the operator suspended it OR its Store store is suspended / deleted. Read on every send claim, every
 * inbound turn (bot, menu, AI agent) and the front desk, from the workspace's own SQLite: the authoritative copy, written in the same
 * transaction that applies the event, so there is no cache and no staleness window inside the workspace (NEVER-stale class). The two flags
 * are separate so an operator unsuspend never lifts a Store hold and a Store reactivation never lifts an operator suspension.
 */
export function isSuspended(sql: SqlStorage, now: number = Date.now()): boolean {
  return sql.exec<{ key: string }>('SELECT key FROM store_state WHERE key IN (?, ?, ?)', SUSPENDED_KEY, STORE_HOLD_KEY, DEBT_HOLD_KEY).toArray().length > 0 || standingStale(sql, now);
}

// ---- STORE-STANDING-2: a Store that goes silent stops spend (default OFF: `STORE_STANDING_STALE_REFUSE`) ----------------------------------
/** Epoch ms the Store's standing (suspended / reactivated / deleted, incl. the 12-hourly re-send) was last RECEIVED; local clock, repeats and older events count. */
const STANDING_AT_KEY = 'store.standing_at';
/** Epoch ms of the last `store.linked` (or the moment the policy was switched on, for a workspace that predates it): the start of the missing-standing window. */
const STANDING_ANCHOR_KEY = 'store.standing_anchor';
/** The policy switch, copied from the env var by the workspace on every wake so the synchronous gate reads it from its own SQLite. */
const STANDING_STRICT_KEY = 'store.standing_strict';
/** Written on every wake for an `sw_` (standalone) id: it has no Store to go silent, so the GATE itself exempts it (a strict row or anchor can never gate it). */
const STANDALONE_KEY = 'store.standalone';
/** The Store re-sends standing every 12 h; two missed heartbeats (24 h) is silence, and 24 h is also how long a freshly linked store may wait for its first one. */
export const STANDING_WINDOW_MS = 24 * 60 * 60 * 1000;
const stateValue = (sql: SqlStorage, key: string): string | null => sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', key).toArray()[0]?.value ?? null;
const putStateValue = (sql: SqlStorage, key: string, value: string): void => { sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value); };
export const noteStandingSeen = (sql: SqlStorage, now: number): void => putStateValue(sql, STANDING_AT_KEY, String(now));
/** A (re)link restarts the window: a standing from before an unlink says nothing about the new link. */
export const noteStoreLinked = (sql: SqlStorage, now: number): void => { putStateValue(sql, STANDING_ANCHOR_KEY, String(now)); sql.exec('DELETE FROM store_state WHERE key = ?', STANDING_AT_KEY); };
/** When the Store's standing last arrived (epoch ms), or null if it never has. */
export const lastStandingAt = (sql: SqlStorage): number | null => { const v = stateValue(sql, STANDING_AT_KEY); return v === null ? null : Number(v); };
export const standingStrict = (sql: SqlStorage): boolean => stateValue(sql, STANDING_STRICT_KEY) === '1';
/**
 * Copies the env switch into the workspace's own SQLite. Unset leaves it alone; '1' turns it on (anchoring the missing-standing window at `now` for a workspace
 * that has no `store.linked` anchor yet, so enabling never refuses anyone before a full window has passed); anything else turns it off.
 */
export function syncStandingPolicy(sql: SqlStorage, flag: string | undefined, now: number, workspaceId: string): void {
  const standalone = isStandaloneId(workspaceId);
  if (standalone) putStateValue(sql, STANDALONE_KEY, '1'); // before the flag check: the exemption holds even when the switch is unset
  if (flag === undefined) return;
  if (standalone) { sql.exec('DELETE FROM store_state WHERE key IN (?, ?)', STANDING_STRICT_KEY, STANDING_ANCHOR_KEY); return; }
  if (flag.trim() === '1') {
    if (!standingStrict(sql)) putStateValue(sql, STANDING_STRICT_KEY, '1');
    if (stateValue(sql, STANDING_ANCHOR_KEY) === null) putStateValue(sql, STANDING_ANCHOR_KEY, String(now));
  } else sql.exec('DELETE FROM store_state WHERE key = ?', STANDING_STRICT_KEY);
}
/**
 * True when the policy is on, the workspace is a Store workspace (an `sw_` standalone one is exempt in here) that is not unlinked (`linked = '0'` is exempt; NO row means linked, as every Store workspace is linked by definition: legacy ones predate the row)
 * that, or none ever came and the link (or the policy switch) is older than that. Fail closed on silence, never on a Store that answered.
 */
export function standingStale(sql: SqlStorage, now: number): boolean {
  if (!standingStrict(sql) || stateValue(sql, STANDALONE_KEY) === '1' || stateValue(sql, 'linked') === '0') return false;
  const seen = stateValue(sql, STANDING_AT_KEY) ?? stateValue(sql, STANDING_ANCHOR_KEY);
  return seen !== null && now - Number(seen) > STANDING_WINDOW_MS;
}
export const debtHold = (sql: SqlStorage): boolean => sql.exec('SELECT 1 FROM store_state WHERE key = ?', DEBT_HOLD_KEY).toArray().length > 0;
export function setDebtHoldFlag(sql: SqlStorage, held: boolean): void {
  if (held) sql.exec("INSERT INTO store_state (key, value) VALUES (?, 'wallet_debt') ON CONFLICT(key) DO UPDATE SET value = excluded.value", DEBT_HOLD_KEY);
  else sql.exec('DELETE FROM store_state WHERE key = ?', DEBT_HOLD_KEY);
}
/** The operator's suspension reason, or null (the `ops.suspended` flag; its value is the reason). */
export const operatorSuspension = (sql: SqlStorage): string | null => sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', SUSPENDED_KEY).toArray()[0]?.value ?? null;
/** Every reason this workspace may not spend, each its own flag (operator reason, Store tag, wallet debt). D1 `suspended_*` is DERIVED from this by `syncSuspendedMirror`. */
export type SuspensionState = { operator: string | null; store: 'store_suspended' | 'store_deleted' | null; debt: boolean; standingStale?: boolean };
export function suspensionState(sql: SqlStorage): SuspensionState {
  const hold = storeHold(sql);
  return { operator: operatorSuspension(sql), store: hold === null ? null : hold === 'store_deleted' ? 'store_deleted' : 'store_suspended', debt: debtHold(sql), standingStale: standingStale(sql, Date.now()) };
}
/** The Store hold's reason, or null when the Store store is live. */
export function storeHold(sql: SqlStorage): string | null {
  return sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', STORE_HOLD_KEY).toArray()[0]?.value ?? null;
}
export function setStoreHoldFlag(sql: SqlStorage, held: boolean, reason: string): void {
  if (held) sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', STORE_HOLD_KEY, reason.slice(0, 200));
  else sql.exec('DELETE FROM store_state WHERE key = ?', STORE_HOLD_KEY);
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
