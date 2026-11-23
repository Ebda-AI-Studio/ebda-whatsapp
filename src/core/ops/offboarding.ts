import type { Env } from '../../env';
import { alert, errClass } from '../observability';
import { parkedPrefix } from '../shared/shared-number';
import { pseudonymiseAuditActors } from './audit-retention';
import { adjustmentThreshold } from '../billing/operator';
import { DRAIN_MAX_BATCHES, drainKeyset } from '../billing/drain';

/**
 * Workspace deletion (OFFBOARD-1, B2). An owner or an operator asks; after a cooling-off window (14 days, an operator may skip it with a reason) a
 * resumable run erases everything a merchant put here and keeps ONLY the money records the law requires, moved to a keyed-HMAC pseudonym so they
 * no longer name the store. Every step is idempotent and recorded in `offboarding.steps_done`, so a failed run resumes where it stopped and a
 * finished one is a no-op. Everything is audited in the append-only `offboarding_log` (ids, step names, counts: never a phone number or a message).
 *
 * Order matters: the numbers are unrouted FIRST (a late webhook then finds no workspace), the Durable Object is wiped before its R2 objects (a
 * prefix listing cannot miss a key the DO would have re-created), and the D1 rows go last in ONE batch.
 */
export const COOLING_OFF_MS = 14 * 86_400_000;
export const STEPS = ['suspend', 'unroute', 'shared', 'wipe_do', 'r2', 'backups', 'd1'] as const;
type Step = (typeof STEPS)[number];
/** R2 listing pages one run deletes per prefix (1000 keys each); more than this continues on the next pass. */
const R2_PAGES_PER_RUN = 20;
const R2_PREFIXES = ['bodies', 'media', 'uploads', 'imports', 'instapay-proof'] as const;

/**
 * Every D1 table that carries a workspace id has a decision here (test/offboarding.test.ts walks the schema, so a new table fails CI until decided).
 *  - delete: rows are removed. Value = the column holding the workspace id.
 *  - keep: a record of money (tax, refunds, disputes). `ws` = the columns rewritten to the pseudonym; `clear` = free-text columns emptied.
 *  - audit: append-only or immutable records (database triggers forbid UPDATE and DELETE). They keep the opaque workspace id (Ruling OFFBOARD-AUDIT-1).
 */
export const OFFBOARD_TABLES = {
  delete: {
    phone_numbers: 'workspace_id', waba_credentials: 'workspace_id', shared_number_members: 'workspace_id', shared_routes: 'workspace_id', shared_sent: 'workspace_id',
    shared_number_sends: 'workspace_id', shared_number_strikes: 'workspace_id', shared_number_errors: 'workspace_id', workspace_subscriptions: 'workspace_id',
    store_plan_applied: 'workspace_id',
    shared_template_requests: 'workspace_id', // the template asks of a store on the shared number: template text only, deleted with the workspace
    waba_signup_users: 'workspace_id', workspace_notices: 'workspace_id', workspace_owners: 'workspace_id', new_cap_usage: 'workspace_id', // final review: Meta-user links, owner notices, the Store owner and the campaign-cap usage go with the workspace
    audit_reasons: 'workspace_id', // operators' free-text reasons (AUDIT-RETENTION-1): deletable on purpose
    instapay_auto_workspace: 'workspace_id', // the per-workspace auto-confirm switch: configuration, nothing to keep
    money_confirmations: 'workspace_id', // single-use money-action tokens (hash only): worthless after the workspace is gone, and they name a user id
    workspace_invitations: 'workspace_id', invite_attempts: 'workspace_id', // CHAT-SA-4: pending invitations (an email address) and invite reservations go with the workspace, before the registry row (foreign key)
    workspace_members: 'workspace_id', // CHAT-SA: a standalone workspace's team (user ids): deleted with the workspace, before the registry row (foreign key)
    erasure_records: 'workspace_id', // the workspace's backups are erased with it, so nothing is left for a restore to bring back
  } as Record<string, string>,
  keep: {
    topups: { people: ['created_by'], clear: [] },
    package_orders: { people: ['created_by'], clear: [] },
    package_refund_plans: { people: [], clear: [] },
    instapay_requests: { people: ['created_by'], clear: ['proof_key', 'proof_mime'] },
    instapay_auto_confirmations: { people: [], clear: [] }, // the auto-confirm decision of an InstaPay request: amounts, reference, reasons, dates; no payer data, no free text (a revert's reason is in audit_reasons)
    refund_requests: { people: ['requested_by'], clear: ['note'] },
    card_refunds: { people: [], clear: ['note'] },
    wallet_adjustments: { people: [], clear: [] }, // requested_by / approved_by are our operators
    shared_number_usage: { people: [], clear: [] },
    credit_order_refunds: { people: [], clear: [] }, // a provider refund of a credit pack: ids and an amount (WA-PACK-REFUND-1); a record of money, kept like credit_orders
    credit_orders: { people: ['created_by'], clear: [] }, // a card purchase of AI credits: amount, credits, provider transaction id; a record of money, kept like topups
    yearly_refund_requests: { people: ['requested_by'], clear: [] }, // a merchant's request to cancel a yearly package and refund unused months: figures only (executed_by is our operator)
  } as Record<string, { people: string[]; clear: string[] }>,
  // Immutable by trigger (a row can be neither updated nor deleted): they keep the opaque workspace id, which names no one once everything above is erased.
  audit: ['operator_actions', 'offboarding', 'offboarding_log', 'ledger_mirror', 'billing_audit', 'workspace_pricing_overrides', 'audit_log', 'operator_view_log'], // operator_view_log: who looked at a workspace, when and which route (no text, the reason is in audit_reasons and goes with the workspace)
};

export type OffboardingStatus = {
  workspaceId: string; state: 'pending' | 'running' | 'done' | 'cancelled'; requestedBy: string; requestedRole: 'owner' | 'operator'; reason: string | null;
  requestedAt: number; executeAfter: number; writeOffMinor: number; stepsDone: string[]; attempts: number; lastError: string | null; finishedAt: number | null;
  /** OFFBOARD-2ND-APPROVER-1: an immediate deletion with a write-off at or above the InstaPay two-approval threshold waits for a second operator. True until one approved THIS request. */
  needsSecondApproval: boolean;
};
type Row = {
  workspace_id: string; state: OffboardingStatus['state']; requested_by: string; requested_role: 'owner' | 'operator'; reason: string | null; requested_at: number; execute_after: number;
  write_off_minor: number; started_at: number | null; finished_at: number | null; steps_done: string; attempts: number; last_error: string | null; pseudonym: string | null;
};
const dto = (r: Row, needsSecondApproval = false): OffboardingStatus => ({
  workspaceId: r.workspace_id, state: r.state, requestedBy: r.requested_by, requestedRole: r.requested_role, reason: r.reason, requestedAt: r.requested_at, executeAfter: r.execute_after,
  writeOffMinor: r.write_off_minor, stepsDone: r.steps_done ? r.steps_done.split(',') : [], attempts: r.attempts, lastError: r.last_error, finishedAt: r.finished_at, needsSecondApproval,
});
const stub = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
/**
 * The statements that record one step of a request. `offboarding_log` is immutable and holds NO free text (ids, actions, counts, numbers only): an operator's or owner's
 * reason goes to the deletable `audit_reasons` and the log row points at it by `reason_id` (the two inserts run back to back in one batch, so `last_insert_rowid()` is the
 * reason just written). A workspace deletion removes the reasons; the ids stay and point at nothing. `detail` must never carry text: callers pass numbers and flags.
 */
const logRows = (env: Env, ws: string, actor: string, action: string, now: number, reason?: string | null, detail?: string, onlyIf?: { sql: string; binds: unknown[] }): D1PreparedStatement[] => {
  const text = reason?.trim() || null;
  const cond = onlyIf ? ` WHERE ${onlyIf.sql}` : '';
  const binds = onlyIf?.binds ?? [];
  return [
    ...(text ? [env.DB.prepare(`INSERT INTO audit_reasons (at, workspace_id, actor, action, reason) SELECT ?, ?, ?, ?, ?${cond}`).bind(now, ws, actor, `offboarding.${action}`, text.slice(0, 500), ...binds)] : []),
    env.DB.prepare(`INSERT INTO offboarding_log (at, workspace_id, actor, action, reason_id, detail) SELECT ?, ?, ?, ?, ${text ? 'last_insert_rowid()' : 'NULL'}, ?${cond}`).bind(now, ws, actor, action, detail ?? null, ...binds),
  ];
};


// ---- second approver (OFFBOARD-2ND-APPROVER-1) and operator holds -----------------------------------------------------------------

/** Does the rule apply to this row (an operator's deletion brought forward from the 14 days, writing off at least the InstaPay two-approval amount)? */
const approvalRule = (env: Env, r: Row): boolean =>
  r.requested_role === 'operator' && r.execute_after < r.requested_at + COOLING_OFF_MS && r.write_off_minor >= adjustmentThreshold(env) && (r.state === 'pending' || r.state === 'running');
/** Everyone who touched this request or released a hold on it: none of them may be the second approver. */
async function involvedActors(env: Env, ws: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT DISTINCT actor FROM offboarding_log WHERE workspace_id = ? AND action IN ('requested', 'taken_over', 'operator_changed', 'write_off_accepted', 'abuse_hold_released')").bind(ws).all<{ actor: string }>();
  return new Set(results.map((x) => x.actor));
}
/** The approval counts only for the exact request it was given for: any later change of date, write-off or requester voids it. */
async function approvedBy(env: Env, r: Row): Promise<string | null> {
  const involved = await involvedActors(env, r.workspace_id); // the requester, everyone who released a hold or accepted a write-off: their approval never counts, whenever it was written
  const { results } = await env.DB.prepare("SELECT actor, detail FROM offboarding_log WHERE workspace_id = ? AND action = 'second_approval' ORDER BY id DESC").bind(r.workspace_id).all<{ actor: string; detail: string | null }>();
  for (const a of results) {
    try {
      const d = JSON.parse(a.detail ?? '{}') as { executeAfter?: number; writeOffMinor?: number; requestedBy?: string };
      if (d.executeAfter === r.execute_after && d.writeOffMinor === r.write_off_minor && d.requestedBy === r.requested_by && a.actor !== r.requested_by && !involved.has(a.actor)) return a.actor;
    } catch { /* not ours */ }
  }
  return null;
}
async function needsApproval(env: Env, r: Row): Promise<boolean> {
  return approvalRule(env, r) && !(await approvedBy(env, r));
}

export type ApproveResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_required' | 'requester_cannot_approve' | 'releaser_cannot_approve' };
export async function approveOffboarding(env: Env, a: { workspaceId: string; actor: string; reason: string }, now = Date.now()): Promise<ApproveResult> {
  const r = await env.DB.prepare("SELECT * FROM offboarding WHERE workspace_id = ? AND state IN ('pending', 'running')").bind(a.workspaceId).first<Row>();
  if (!r) return { ok: false, reason: 'not_found' };
  if (!approvalRule(env, r)) return { ok: false, reason: 'not_required' };
  if (a.actor === r.requested_by) return { ok: false, reason: 'requester_cannot_approve' };
  if ((await involvedActors(env, a.workspaceId)).has(a.actor)) return { ok: false, reason: 'releaser_cannot_approve' };
  await env.DB.batch(logRows(env, a.workspaceId, a.actor, 'second_approval', now, a.reason, JSON.stringify({ executeAfter: r.execute_after, writeOffMinor: r.write_off_minor, requestedBy: r.requested_by })));
  return { ok: true };
}

export type ReleaseHoldResult = { ok: true } | { ok: false; reason: 'not_found' | 'not_held' | 'approver_cannot_release' };
/** An operator lifts the abuse hold (a suspension for abuse keeps its evidence until a person says it may go). Audited with the reason. */
export async function releaseAbuseHold(env: Env, a: { workspaceId: string; actor: string; reason: string }, now = Date.now()): Promise<ReleaseHoldResult> {
  const r = await env.DB.prepare("SELECT 1 FROM offboarding WHERE workspace_id = ? AND state IN ('pending', 'running')").bind(a.workspaceId).first();
  if (!r) return { ok: false, reason: 'not_found' };
  if (!(await abuseSuspended(env, a.workspaceId))) return { ok: false, reason: 'not_held' };
  if (await env.DB.prepare("SELECT 1 FROM offboarding_log WHERE workspace_id = ? AND action = 'second_approval' AND actor = ? LIMIT 1").bind(a.workspaceId, a.actor).first()) return { ok: false, reason: 'approver_cannot_release' };
  await env.DB.batch(logRows(env, a.workspaceId, a.actor, 'abuse_hold_released', now, a.reason));
  return { ok: true };
}
export async function abuseSuspended(env: Env, ws: string): Promise<boolean> {
  const w = await env.DB.prepare('SELECT suspended_at, suspended_reason FROM workspaces WHERE id = ?').bind(ws).first<{ suspended_at: number | null; suspended_reason: string | null }>();
  // A Store hold (STORE-STANDING-1: the Store store is suspended or deleted) is not an abuse suspension either: it never holds an erasure; nor does a wallet debt hold (WA-DEBT-1, a money block). D1's reason is derived with the operator's reason first, so any other reason is an operator suspension.
  return !!w && w.suspended_at !== null && w.suspended_reason !== 'offboarding' && w.suspended_reason !== 'store_suspended' && w.suspended_reason !== 'store_deleted' && w.suspended_reason !== 'wallet_debt';
}

export async function getOffboarding(env: Env, ws: string): Promise<OffboardingStatus | null> {
  const r = await env.DB.prepare('SELECT * FROM offboarding WHERE workspace_id = ?').bind(ws).first<Row>();
  return r ? dto(r, await needsApproval(env, r)) : null;
}
/** The status with its audit trail, newest last (what the operator console shows). */
export async function getOffboardingWithLog(env: Env, ws: string): Promise<(OffboardingStatus & { log: { at: number; actor: string; action: string; reason: string | null }[] }) | null> {
  const st = await getOffboarding(env, ws);
  if (!st) return null;
  const { results } = await env.DB.prepare('SELECT l.at, l.actor, l.action, r.reason FROM offboarding_log l LEFT JOIN audit_reasons r ON r.id = l.reason_id WHERE l.workspace_id = ? ORDER BY l.id DESC LIMIT 50').bind(ws).all<{ at: number; actor: string; action: string; reason: string | null }>();
  return { ...st, log: results.reverse() };
}
export async function listOffboardings(env: Env, state?: string): Promise<OffboardingStatus[]> {
  const q = state ? env.DB.prepare('SELECT * FROM offboarding WHERE state = ? ORDER BY execute_after LIMIT 200').bind(state) : env.DB.prepare('SELECT * FROM offboarding ORDER BY requested_at DESC LIMIT 200');
  const out: OffboardingStatus[] = [];
  for (const r of (await q.all<Row>()).results) out.push(dto(r, await needsApproval(env, r)));
  return out;
}
/** True once a deletion has started: the workspace is being (or has been) erased, so late queue messages for it are dropped instead of retried. */
export async function isOffboarding(env: Env, ws: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM offboarding WHERE workspace_id = ? AND state IN ('running', 'done')").bind(ws).first());
}

/** The id the money records of a deleted workspace move to: HMAC-SHA-256 under a key derived (HKDF) from ERASURE_HMAC_KEY (ERASURE-KEY-1: never rotated, unlike TOKEN_ENC_KEY), truncated to 128 bits. Null = no key (fail closed). */
export async function pseudonymFor(env: Env, ws: string): Promise<string | null> {
  const secret = env.ERASURE_HMAC_KEY;
  if (!secret) return null;
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('offboard-pseudonym/v1') }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(ws)));
  return `del_${[...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type RequestResult = { ok: true; value: OffboardingStatus } | { ok: false; reason: 'not_found' | 'wallet_balance_remains' | 'already_running' | 'already_deleted' | 'no_key' } | { ok: false; reason: 'write_off_required'; amountMinor: number };
export async function requestOffboarding(
  env: Env, a: { workspaceId: string; actor: string; role: 'owner' | 'operator'; reason?: string; immediate?: boolean; acceptWriteOff?: boolean }, now = Date.now(),
): Promise<RequestResult> {
  const ws = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(a.workspaceId).first();
  if (!ws) return { ok: false, reason: 'not_found' };
  if (!(await pseudonymFor(env, a.workspaceId))) return { ok: false, reason: 'no_key' }; // never promise a deletion that could not keep its money records safely
  const existing = await env.DB.prepare('SELECT * FROM offboarding WHERE workspace_id = ?').bind(a.workspaceId).first<Row>();
  if (existing?.state === 'running') {
    // A run held because the balance grew past the write-off may be released by an OPERATOR who accepts the new amount (audited). Nothing else changes a running row.
    const done = new Set(existing.steps_done ? existing.steps_done.split(',') : []);
    if (a.role === 'operator' && existing.last_error === 'held:balance_grew' && !done.has('wipe_do')) {
      const balance = Math.max(0, (await stub(env, a.workspaceId).walletView(now)).balanceMinor);
      if (balance > existing.write_off_minor) {
        if (!a.acceptWriteOff) return { ok: false, reason: 'write_off_required', amountMinor: balance };
        const detail = JSON.stringify({ previous: { write_off_minor: existing.write_off_minor }, new: { write_off_minor: balance } });
        const [upd] = await env.DB.batch([
          env.DB.prepare("UPDATE offboarding SET write_off_minor = ?, requested_by = ?, last_error = NULL WHERE workspace_id = ? AND state = 'running' AND write_off_minor = ?").bind(balance, a.actor, a.workspaceId, existing.write_off_minor),
          ...logRows(env, a.workspaceId, a.actor, 'write_off_accepted', now, a.reason, detail),
        ]);
        if (!upd!.meta.changes) return { ok: false, reason: 'already_running' };
        return { ok: true, value: (await getOffboarding(env, a.workspaceId))! };
      }
    }
    return { ok: false, reason: 'already_running' };
  }
  if (existing?.state === 'done') return { ok: false, reason: 'already_deleted' };
  const executeAfter = a.immediate && a.role === 'operator' ? now : now + COOLING_OFF_MS;
  if (existing?.state === 'pending') {
    // An owner asking again changes nothing, and never downgrades an operator-owned row.
    if (a.role !== 'operator') return { ok: true, value: dto(existing) };
    // An operator asking TAKES IT OVER in one conditional statement (role, requester, reason, the earlier of the two dates, the write-off), so the owner can no
    // longer cancel it. The balance is read again: it may have grown since the owner accepted a write-off, and the operator has to accept the new amount.
    const after = Math.min(existing.execute_after, executeAfter);
    const balance = Math.max(0, (await stub(env, a.workspaceId).walletView(now)).balanceMinor);
    let writeOff = existing.write_off_minor;
    if (balance > writeOff) {
      if (!a.acceptWriteOff) return { ok: false, reason: 'write_off_required', amountMinor: balance };
      writeOff = balance;
    }
    const reason = a.reason ?? null;
    const takenOver = existing.requested_role !== 'operator';
    const expedited = after < existing.execute_after;
    if (!takenOver && !expedited && existing.requested_by === a.actor && existing.reason === reason && writeOff === existing.write_off_minor) return { ok: true, value: dto(existing) }; // nothing changes: nothing is written
    const detail = JSON.stringify({ // numbers, ids and flags only: the reasons are in audit_reasons
      previous: { requested_role: existing.requested_role, requested_by: existing.requested_by, execute_after: existing.execute_after, write_off_minor: existing.write_off_minor },
      new: { requested_role: 'operator', requested_by: a.actor, execute_after: after, write_off_minor: writeOff },
      taken_over: takenOver, expedited,
    });
    const [upd] = await env.DB.batch([
      env.DB.prepare("UPDATE offboarding SET requested_role = 'operator', requested_by = ?, reason = ?, execute_after = ?, write_off_minor = ? WHERE workspace_id = ? AND state = 'pending'").bind(a.actor, reason, after, writeOff, a.workspaceId),
      // The log row is written only if the update above applied (the same batch, so a run that claimed the row in between leaves no false entry).
      ...logRows(env, a.workspaceId, a.actor, takenOver ? 'taken_over' : 'operator_changed', now, reason, detail, { sql: "EXISTS (SELECT 1 FROM offboarding WHERE workspace_id = ? AND state = 'pending' AND requested_by = ? AND requested_role = 'operator')", binds: [a.workspaceId, a.actor] }),
    ]);
    if (!upd!.meta.changes) return { ok: false, reason: 'already_running' };
    return { ok: true, value: (await getOffboarding(env, a.workspaceId))! };
  }
  const balance = (await stub(env, a.workspaceId).walletView(now)).balanceMinor;
  if (balance > 0 && !a.acceptWriteOff) return { ok: false, reason: 'wallet_balance_remains' };
  const writeOff = Math.max(0, balance);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO offboarding (workspace_id, state, requested_by, requested_role, reason, requested_at, execute_after, write_off_minor) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET state = 'pending', requested_by = excluded.requested_by, requested_role = excluded.requested_role, reason = excluded.reason, requested_at = excluded.requested_at,
         execute_after = excluded.execute_after, write_off_minor = excluded.write_off_minor, started_at = NULL, finished_at = NULL, steps_done = '', attempts = 0, last_error = NULL`,
    ).bind(a.workspaceId, a.actor, a.role, a.reason ?? null, now, executeAfter, writeOff),
    ...logRows(env, a.workspaceId, a.actor, 'requested', now, a.reason, writeOff ? `write_off_minor=${writeOff}` : undefined),
  ]);
  console.log(JSON.stringify({ audit: 'offboarding_requested', workspace: a.workspaceId, role: a.role, immediate: executeAfter === now }));
  return { ok: true, value: (await getOffboarding(env, a.workspaceId))! };
}

export type CancelResult = { ok: true } | { ok: false; reason: 'not_found' | 'nothing_pending' | 'already_running' | 'operator_requested' };
export async function cancelOffboarding(env: Env, a: { workspaceId: string; actor: string; role: 'owner' | 'operator'; reason?: string }, now = Date.now()): Promise<CancelResult> {
  const row = await env.DB.prepare('SELECT state, requested_role FROM offboarding WHERE workspace_id = ?').bind(a.workspaceId).first<{ state: string; requested_role: string }>();
  if (!row) return { ok: false, reason: 'not_found' };
  // A deletion an operator started (a legal or abuse request) is cancelled by an operator only: the owner is told to write to support.
  if (row.state === 'pending' && row.requested_role === 'operator' && a.role !== 'operator') return { ok: false, reason: 'operator_requested' };
  if (row.state === 'running' || row.state === 'done') return { ok: false, reason: 'already_running' };
  if (row.state !== 'pending') return { ok: false, reason: 'nothing_pending' };
  const res = await env.DB.prepare("UPDATE offboarding SET state = 'cancelled', reason = NULL WHERE workspace_id = ? AND state = 'pending'").bind(a.workspaceId).run();
  if (!res.meta.changes) return { ok: false, reason: 'already_running' }; // the run started between our read and our write
  await env.DB.batch(logRows(env, a.workspaceId, a.actor, 'cancelled', now, a.reason));
  return { ok: true };
}

/**
 * Work in flight that a deletion must not cut off. Null = clear to go. Money is held on ANY open row however old (a late confirmation would otherwise credit a
 * deleted workspace, review item 2): an open refund, a card refund, a pending yearly-refund request, a top-up, credit-pack or package order still pending, a paid-but-ungranted order, an InstaPay request
 * awaiting proof or review (or confirmed and not granted).
 */
async function moneyHold(env: Env, ws: string): Promise<string | null> {
  const q = (sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).first();
  if (await q("SELECT 1 FROM refund_requests WHERE workspace_id = ? AND state IN ('pending', 'processing', 'manual_payout', 'abandoning')", ws)) return 'open_refund';
  if (await q("SELECT 1 FROM card_refunds WHERE workspace_id = ? AND state IN ('planned', 'sending', 'calling', 'pending', 'uncertain', 'held')", ws)) return 'open_card_refund';
  if (await q("SELECT 1 FROM topups WHERE workspace_id = ? AND state = 'pending'", ws)) return 'payment_in_flight';
  if (await q("SELECT 1 FROM package_orders WHERE workspace_id = ? AND (status = 'pending' OR (status = 'paid' AND granted_at IS NULL))", ws)) return 'payment_in_flight';
  if (await q("SELECT 1 FROM credit_orders WHERE workspace_id = ? AND state = 'pending'", ws)) return 'payment_in_flight'; // an AI-credit card purchase still waiting for its payment
  if (await q("SELECT 1 FROM yearly_refund_requests WHERE workspace_id = ? AND state = 'pending'", ws)) return 'open_yearly_refund_request'; // the merchant asked to cancel a yearly package and be refunded: a person must run it first
  if (await q("SELECT 1 FROM instapay_requests WHERE workspace_id = ? AND (state IN ('awaiting_proof', 'under_review') OR (state = 'confirmed' AND granted_at IS NULL))", ws)) return 'payment_in_flight';
  return null;
}

/** Before anything is touched: money in flight, an abuse suspension nobody released, a missing second approval. */
async function startHold(env: Env, row: Row): Promise<string | null> {
  const ws = row.workspace_id;
  const money = await moneyHold(env, ws);
  if (money) return money;
  if (await abuseSuspended(env, ws)) {
    const released = await env.DB.prepare("SELECT 1 FROM offboarding_log WHERE workspace_id = ? AND action = 'abuse_hold_released' AND at >= ? LIMIT 1").bind(ws, row.requested_at).first();
    if (!released) return 'suspended_abuse';
  }
  if (await needsApproval(env, row)) return 'second_approval_required';
  return null;
}
/** Right before the wipe: a balance that grew beyond what the owner (or an operator) agreed to give up is never erased silently (review item 1). */
async function balanceHold(env: Env, row: Row, now: number): Promise<string | null> {
  const balance = Math.max(0, (await stub(env, row.workspace_id).walletView(now)).balanceMinor);
  return balance > row.write_off_minor ? 'balance_grew' : null;
}

/** Deletes one prefix's objects, a bounded number of pages. Returns true when the prefix is empty. */
async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<boolean> {
  for (let i = 0; i < R2_PAGES_PER_RUN; i++) {
    const page = await bucket.list({ prefix, limit: 1000 });
    if (!page.objects.length) return true;
    await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return true;
  }
  return false;
}

class Unfinished extends Error {}

async function runStep(env: Env, ws: string, step: Step, pseudo: string, now: number): Promise<string | undefined> {
  switch (step) {
    case 'suspend': {
      // WA-DEBT-1: the erasure of DATA is never blocked by a debt, but the DEBT survives it. A negative wallet is recorded ONCE in the append-only offboarding log (`debt_preserved`,
      // the amount) next to the full ledger copy in D1 `ledger_mirror` (kept), with a P1 alert. It is never written off here: a write-off exists only for a positive balance the
      // owner gives up (`write_off_accepted`, explicit approval), and nothing on the way out pays or refunds against a debt.
      const debt = -Math.min(0, (await stub(env, ws).walletView(now)).balanceMinor);
      if (debt > 0 && !(await env.DB.prepare("SELECT 1 FROM offboarding_log WHERE workspace_id = ? AND action = 'debt_preserved' LIMIT 1").bind(ws).first())) {
        await env.DB.batch(logRows(env, ws, 'system', 'debt_preserved', now, null, `debt_minor=${debt}`));
        alert('offboarding_debt_outstanding', { workspace: ws, debtMinor: debt });
      }
      await env.DB.prepare("UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = coalesce(suspended_reason, 'offboarding') WHERE id = ?").bind(now, ws).run();
      await stub(env, ws).setSuspended(true, 'offboarding', now);
      return;
    }
    case 'unroute': {
      // The sender numbers and their tokens go first: a late webhook or queued send then finds no workspace.
      await env.DB.batch([
        env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id IN (SELECT phone_number_id FROM phone_numbers WHERE workspace_id = ?)').bind(ws),
        env.DB.prepare('DELETE FROM waba_credentials WHERE workspace_id = ?').bind(ws),
        env.DB.prepare('DELETE FROM phone_numbers WHERE workspace_id = ?').bind(ws),
        env.DB.prepare('DELETE FROM shared_number_members WHERE workspace_id = ?').bind(ws),
      ]);
      return;
    }
    case 'shared': {
      // Messages parked on the platform number for customers only this store wrote to; then the routing rows themselves.
      const routes = (await env.DB.prepare(
        `SELECT DISTINCT r.phone_number_id AS pn, r.customer_key AS ck FROM shared_routes r WHERE r.workspace_id = ?
           AND NOT EXISTS (SELECT 1 FROM shared_routes o WHERE o.phone_number_id = r.phone_number_id AND o.customer_key = r.customer_key AND o.workspace_id <> r.workspace_id)`,
      ).bind(ws).all<{ pn: string; ck: string }>()).results;
      for (const r of routes) {
        if (!(await deletePrefix(env.MEDIA, parkedPrefix(r.pn, r.ck)))) throw new Unfinished();
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM shared_routes WHERE workspace_id = ?').bind(ws),
        env.DB.prepare('DELETE FROM shared_sent WHERE workspace_id = ?').bind(ws),
      ]);
      return `parked_customers=${routes.length}`;
    }
    case 'wipe_do': {
      const r = await stub(env, ws).offboardWipe();
      return `vectors=${r.vectors}`;
    }
    case 'r2': {
      for (const p of R2_PREFIXES) if (!(await deletePrefix(env.MEDIA, `${p}/${ws}/`))) throw new Unfinished();
      return;
    }
    case 'backups': {
      if (!(await deletePrefix(env.BACKUPS, `backups/${ws}/`))) throw new Unfinished();
      return;
    }
    case 'd1': {
      // A backup that was still being written when the backups step listed the prefix (the wipe now waits for it, but a Durable Object restart can still race): list again.
      if (!(await deletePrefix(env.BACKUPS, `backups/${ws}/`))) throw new Unfinished();
      const stmts: D1PreparedStatement[] = [
        env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(pseudo, 'deleted workspace', now),
      ];
      for (const [t, col] of Object.entries(OFFBOARD_TABLES.delete)) stmts.push(env.DB.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).bind(ws));
      for (const [t, k] of Object.entries(OFFBOARD_TABLES.keep)) {
        const sets = ['workspace_id = ?', ...k.people.map((c) => `${c} = ?`), ...k.clear.map((c) => `${c} = NULL`)];
        stmts.push(env.DB.prepare(`UPDATE ${t} SET ${sets.join(', ')} WHERE workspace_id = ?`).bind(pseudo, ...k.people.map(() => pseudo), ws));
      }
      stmts.push(env.DB.prepare('UPDATE standalone_invites SET used_workspace_id = NULL WHERE used_workspace_id = ?').bind(ws)); // CHAT-SA: the creation code stays as an audit record of who used it, but no longer names the workspace
      stmts.push(...pseudonymiseAuditActors(env, ws, pseudo)); // the merchant's user ids in audit_log, through the controlled drop / update / re-create sequence (one transaction with the rest)
      stmts.push(env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(ws));
      await env.DB.batch(stmts);
      return;
    }
  }
}

/** Test seams: a pause between reading the row and claiming it, and before each destructive step. Production passes none. */
export type RunHooks = { afterRead?: () => Promise<void>; beforeStep?: (step: Step) => Promise<void> };

/** Runs (or resumes) one workspace's deletion. Never throws. */
export async function runOffboarding(env: Env, ws: string, now = Date.now(), hooks: RunHooks = {}): Promise<'done' | 'failed' | 'held' | 'unfinished' | 'skipped'> {
  const row = await env.DB.prepare('SELECT * FROM offboarding WHERE workspace_id = ?').bind(ws).first<Row>();
  if (!row || (row.state !== 'pending' && row.state !== 'running') || row.execute_after > now) return 'skipped';
  await hooks.afterRead?.();
  const done = new Set(row.steps_done ? row.steps_done.split(',') : []);
  const hold = async (reason: string): Promise<'held'> => {
    const first = row.last_error !== `held:${reason}`;
    await env.DB.prepare("UPDATE offboarding SET last_error = ? WHERE workspace_id = ? AND state IN ('pending', 'running')").bind(`held:${reason}`, ws).run();
    if (first) alert('offboarding_held', { workspace: ws, reason });
    return 'held';
  };
  if (done.size === 0) {
    const held = await startHold(env, row);
    if (held) return hold(held);
  }
  if (!done.has('wipe_do')) {
    const grew = await balanceHold(env, row, now);
    if (grew) return hold(grew);
  }
  // ERASURE-KEY-1: the pseudonym is computed ONCE and stored; a retry (even after a key change) reuses the stored one, so money records never end up under two ids.
  const pseudo = row.pseudonym ?? await pseudonymFor(env, ws);
  if (!pseudo) {
    alert('offboarding_failed', { workspace: ws, error: 'no_key' });
    return 'failed';
  }
  // The claim is ONE conditional write: a request cancelled (or not yet due) since we read it is not claimed, and nothing irreversible runs.
  const claim = await env.DB.prepare(
    "UPDATE offboarding SET state = 'running', attempts = attempts + 1, pseudonym = coalesce(pseudonym, ?), started_at = coalesce(started_at, ?) WHERE workspace_id = ? AND state IN ('pending', 'running') AND execute_after <= ?",
  ).bind(pseudo, now, ws, now).run();
  if (!claim.meta.changes) return 'skipped';
  if (row.state === 'pending') await env.DB.batch(logRows(env, ws, 'system', 'started', now));
  for (const step of STEPS) {
    if (done.has(step)) continue;
    await hooks.beforeStep?.(step);
    // Re-checked before EVERY step: a cancel that lands mid-run stops the next (irreversible) step.
    const live = await env.DB.prepare("SELECT * FROM offboarding WHERE workspace_id = ? AND state = 'running'").bind(ws).first<Row>();
    if (!live) return 'skipped';
    // The second approval is checked against the row AS IT IS NOW, before every irreversible step: a write-off raised while the run is in flight voids the approval (review).
    if (step !== 'suspend' && (await needsApproval(env, live))) return hold('second_approval_required');
    // The point of no return: the balance is read again right before the wipe (a credit may have landed since the first check).
    if (step === 'wipe_do') {
      const grew = await balanceHold(env, row, now);
      if (grew) return hold(grew);
    }
    try {
      const detail = await runStep(env, ws, step, pseudo, now);
      done.add(step);
      await env.DB.batch([
        env.DB.prepare('UPDATE offboarding SET steps_done = ?, last_error = NULL WHERE workspace_id = ?').bind(STEPS.filter((s) => done.has(s)).join(','), ws),
        ...logRows(env, ws, 'system', 'step_done', now, null, detail ? `${step} ${detail}` : step),
      ]);
    } catch (err) {
      const unfinished = err instanceof Unfinished;
      await env.DB.prepare('UPDATE offboarding SET last_error = ? WHERE workspace_id = ?').bind(unfinished ? `unfinished:${step}` : `${step}:${errClass(err)}`, ws).run();
      if (!unfinished) alert('offboarding_failed', { workspace: ws, step, error: errClass(err) });
      return unfinished ? 'unfinished' : 'failed';
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE offboarding SET state = 'done', finished_at = ?, last_error = NULL, reason = NULL WHERE workspace_id = ?").bind(now, ws), // the request row keeps no free text either
    ...logRows(env, ws, 'system', 'completed', now),
  ]);
  console.log(JSON.stringify({ audit: 'offboarding_completed', workspace: ws }));
  return 'done';
}

/** Rows read per page by the daily pass; a test passes smaller numbers. */
export const OFFBOARD_PAGE = 20;
/**
 * The daily pass (and the operator's "run now"): every due or interrupted deletion, one at a time, paged by KEYSET (execute_after, workspace_id) so held rows
 * can never starve a later one (the M-178 class). A pass that stops with due rows left raises `offboarding_backlog` (P1).
 */
export async function runDueOffboardings(env: Env, now = Date.now(), opts: { pageSize?: number; maxBatches?: number } = {}): Promise<{ processed: number; failed: number; held: number }> {
  const out = { processed: 0, failed: 0, held: 0 };
  const pageSize = opts.pageSize ?? OFFBOARD_PAGE;
  const { capped } = await drainKeyset<{ workspace_id: string; execute_after: number }, { at: number; ws: string }>({
    name: 'offboarding', pageSize, maxBatches: opts.maxBatches ?? DRAIN_MAX_BATCHES,
    page: async (after) => (await env.DB.prepare(
      `SELECT workspace_id, execute_after FROM offboarding WHERE state IN ('pending', 'running') AND execute_after <= ?1
         AND (?2 IS NULL OR execute_after > ?2 OR (execute_after = ?2 AND workspace_id > ?3)) ORDER BY execute_after, workspace_id LIMIT ?4`,
    ).bind(now, after?.at ?? null, after?.ws ?? '', pageSize).all<{ workspace_id: string; execute_after: number }>()).results,
    cursorOf: (r) => ({ at: r.execute_after, ws: r.workspace_id }),
    handle: async (r) => {
      const res = await runOffboarding(env, r.workspace_id, now);
      if (res === 'done') out.processed++;
      else if (res === 'failed' || res === 'unfinished') out.failed++;
      else if (res === 'held') out.held++;
    },
  });
  if (capped) alert('offboarding_backlog', { severity: 'P1', processed: out.processed, held: out.held, failed: out.failed });
  return out;
}
