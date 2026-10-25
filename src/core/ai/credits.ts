/**
 * AI credits: an append-only ledger inside the workspace Durable Object (Phase 7 design, section 7.5). Whole numbers only.
 *
 * - `credit_ledger` rows are never updated or deleted (SQLite triggers); every row has a unique `ref`, so a retried write is a no-op.
 * - Before the model is called one credit is HELD (`credit_holds`), and after the call it is SETTLED (charged) or RELEASED.
 *   `available = balance - held`, read and written in one synchronous transaction, so concurrent messages cannot overdraw.
 * - A workspace that brings its own model key is never debited (the caller simply does not hold).
 * - Monthly grant `grant:<period_start>:<package>`; an upgrade tops up the difference; `expire:<period_start>` removes the unused
 *   GRANTED credits at period end while purchased credits roll over (consumption draws on the grant first).
 * No phone number or name is stored here, so erasure never touches it.
 */
import { addTask } from '../scheduler';

type Sql = DurableObjectStorage['sql'];

export const AI_TURN_CREDITS = 1;
/** A hold whose turn crashed frees itself after this long. */
export const HOLD_TTL_MS = 10 * 60_000;

export type CreditKind = 'grant' | 'purchase' | 'ai_charge' | 'expire' | 'refund' | 'adjustment';
export type Posted = { ok: true; balance: number } | { ok: false; reason: 'duplicate' | 'invalid' };

export const creditBalance = (sql: Sql): number => sql.exec<{ b: number }>('SELECT coalesce((SELECT balance_after FROM credit_ledger ORDER BY id DESC LIMIT 1), 0) AS b').one().b;
const heldNow = (sql: Sql, now: number): number => sql.exec<{ h: number }>("SELECT coalesce(sum(amount), 0) AS h FROM credit_holds WHERE state = 'held' AND expires_at > ?", now).one().h;
export const creditsAvailable = (sql: Sql, now: number): number => creditBalance(sql) - heldNow(sql, now);

/** Appends one row. Call inside a transaction (balance is read and written without an await between). */
export function postCredit(sql: Sql, r: { kind: CreditKind; amount: number; ref: string; now: number; parentRef?: string; actor?: string; note?: string }): Posted {
  if (!Number.isSafeInteger(r.amount) || r.amount === 0 || !r.ref) return { ok: false, reason: 'invalid' };
  if (sql.exec('SELECT 1 FROM credit_ledger WHERE ref = ?', r.ref).toArray().length) return { ok: false, reason: 'duplicate' };
  const balance = creditBalance(sql) + r.amount;
  sql.exec('INSERT INTO credit_ledger (at, kind, amount, balance_after, ref, parent_ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.now, r.kind, r.amount, balance, r.ref, r.parentRef ?? null, r.actor ?? null, r.note ?? null);
  // Copied to D1 by the ledger_drain task (same outbox as the wallet ledger); written in this very transaction.
  sql.exec("INSERT INTO ledger_outbox (ledger, ref, row_json) VALUES ('credit', ?, ?)", r.ref, JSON.stringify({ at: r.now, kind: r.kind, amount: r.amount, balance_after: balance }));
  addTask(sql, 'ledger_drain', r.now + 1000);
  return { ok: true, balance };
}

export type HoldResult = 'held' | 'already_charged' | 'insufficient';

/** Reserves `amount` credits under `ref` (deterministic per turn, so a replay finds its own hold). Call inside a transaction. */
export function holdCredits(sql: Sql, ref: string, now: number, amount = AI_TURN_CREDITS): HoldResult {
  sql.exec("UPDATE credit_holds SET state = 'expired', settled_at = ? WHERE state = 'held' AND expires_at <= ?", now, now);
  const have = sql.exec<{ state: string }>('SELECT state FROM credit_holds WHERE ref = ?', ref).toArray()[0];
  if (have?.state === 'charged') return 'already_charged';
  if (have?.state === 'held') {
    sql.exec('UPDATE credit_holds SET expires_at = ? WHERE ref = ?', now + HOLD_TTL_MS, ref);
    return 'held';
  }
  if (creditsAvailable(sql, now) < amount) return 'insufficient';
  sql.exec(
    "INSERT INTO credit_holds (ref, amount, state, created_at, expires_at) VALUES (?, ?, 'held', ?, ?) ON CONFLICT(ref) DO UPDATE SET state = 'held', created_at = excluded.created_at, expires_at = excluded.expires_at, settled_at = NULL",
    ref, amount, now, now + HOLD_TTL_MS,
  );
  return 'held';
}

/** A live turn calls this at every model/tool round so its hold never lapses while it works. */
export function heartbeatHold(sql: Sql, ref: string, now: number): void {
  sql.exec("UPDATE credit_holds SET expires_at = ? WHERE ref = ? AND state = 'held'", now + HOLD_TTL_MS, ref);
}

/**
 * Turns a hold into a charge (`ref` of the ledger row = the hold's ref). Idempotent. Call inside a transaction.
 * A hold that lapsed (its turn was silent for longer than the TTL) no longer protects its credit, which may have been given to
 * another call: it is charged only if a credit is still available; otherwise nothing is posted ('refused', alerted) so the
 * balance can never go negative.
 */
export function settleHold(sql: Sql, ref: string, now: number): 'charged' | 'refused' | 'noop' {
  const h = sql.exec<{ amount: number; state: string; expires_at: number }>('SELECT amount, state, expires_at FROM credit_holds WHERE ref = ?', ref).toArray()[0];
  if (!h || h.state === 'charged' || h.state === 'released') return 'noop';
  const lapsed = h.state === 'expired' || h.expires_at <= now;
  if (lapsed && creditsAvailable(sql, now) < h.amount) {
    sql.exec("UPDATE credit_holds SET state = 'released', settled_at = ? WHERE ref = ?", now, ref);
    console.error(JSON.stringify({ alert: 'ai_overdraw_refused', ref: ref.slice(0, 40) }));
    return 'refused';
  }
  postCredit(sql, { kind: 'ai_charge', amount: -h.amount, ref, parentRef: ref, now });
  sql.exec("UPDATE credit_holds SET state = 'charged', settled_at = ? WHERE ref = ?", now, ref);
  return 'charged';
}

/** Gives a hold back unused (the model never answered). Idempotent. Call inside a transaction. */
export function releaseHold(sql: Sql, ref: string, now: number): void {
  sql.exec("UPDATE credit_holds SET state = 'released', settled_at = ? WHERE ref = ? AND state = 'held'", now, ref);
}

const grantedInPeriod = (sql: Sql, periodStart: number): number =>
  sql.exec<{ g: number }>("SELECT coalesce(sum(amount), 0) AS g FROM credit_ledger WHERE kind = 'grant' AND ref LIKE ?", `grant:${periodStart}:%`).one().g;

/** The period's monthly grant. The same (period, package) twice is one grant. */
export function grantCredits(sql: Sql, a: { periodStart: number; packageId: string; credits: number; now: number; actor?: string }): Posted {
  return postCredit(sql, { kind: 'grant', amount: a.credits, ref: `grant:${a.periodStart}:${a.packageId}`, now: a.now, ...(a.actor ? { actor: a.actor } : {}) });
}

/** Moving to a bigger package mid-period grants only the difference to what this period already received. */
export function upgradeGrant(sql: Sql, a: { periodStart: number; toPackage: string; toCredits: number; now: number; actor?: string }): Posted {
  const diff = a.toCredits - grantedInPeriod(sql, a.periodStart);
  if (diff <= 0) return { ok: false, reason: 'invalid' };
  return grantCredits(sql, { periodStart: a.periodStart, packageId: a.toPackage, credits: diff, now: a.now, ...(a.actor ? { actor: a.actor } : {}) });
}

/** Period end: the granted credits nobody used expire (consumption draws on the grant first); purchased credits roll over. Returns how many expired. */
export function expireGrant(sql: Sql, a: { periodStart: number; now: number; ref?: string }): number {
  const used = sql.exec<{ u: number }>("SELECT coalesce(-sum(amount), 0) AS u FROM credit_ledger WHERE kind = 'ai_charge' AND at >= ?", a.periodStart).one().u;
  const unused = Math.min(Math.max(0, grantedInPeriod(sql, a.periodStart) - used), creditsAvailable(sql, a.now));
  if (unused <= 0) return 0;
  const r = postCredit(sql, { kind: 'expire', amount: -unused, ref: a.ref ?? `expire:${a.periodStart}`, now: a.now });
  return r.ok ? unused : 0;
}

/** A partial refund: `num/den` of the period's UNUSED granted credits expire (a ledger row under `ref`, so a retry is a no-op; used credits stay used). */
export function expireGrantFraction(sql: Sql, a: { periodStart: number; num: number; den: number; now: number; ref: string }): number {
  if (!(a.num > 0 && a.den > 0)) return 0;
  const used = sql.exec<{ u: number }>("SELECT coalesce(-sum(amount), 0) AS u FROM credit_ledger WHERE kind = 'ai_charge' AND at >= ?", a.periodStart).one().u;
  const unused = Math.min(Math.max(0, grantedInPeriod(sql, a.periodStart) - used), creditsAvailable(sql, a.now));
  const amount = Math.floor((unused * a.num) / a.den);
  if (amount <= 0) return 0;
  const r = postCredit(sql, { kind: 'expire', amount: -amount, ref: a.ref, now: a.now });
  return r.ok ? amount : 0;
}
