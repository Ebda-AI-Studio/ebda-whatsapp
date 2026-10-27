import type { Env } from '../../env';
import { alert, errClass } from '../observability';
import { parkedPrefix } from '../shared/shared-number';

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
    erasure_records: 'workspace_id', // the workspace's backups are erased with it, so nothing is left for a restore to bring back
  } as Record<string, string>,
  keep: {
    topups: { people: ['created_by'], clear: [] },
    package_orders: { people: ['created_by'], clear: [] },
    package_refund_plans: { people: [], clear: [] },
    instapay_requests: { people: ['created_by'], clear: ['proof_key', 'proof_mime'] },
    refund_requests: { people: ['requested_by'], clear: ['note'] },
    card_refunds: { people: [], clear: ['note'] },
    wallet_adjustments: { people: [], clear: [] }, // requested_by / approved_by are our operators
    shared_number_usage: { people: [], clear: [] },
  } as Record<string, { people: string[]; clear: string[] }>,
  // Immutable by trigger (a row can be neither updated nor deleted): they keep the opaque workspace id, which names no one once everything above is erased.
  audit: ['operator_actions', 'offboarding', 'offboarding_log', 'ledger_mirror', 'billing_audit', 'workspace_pricing_overrides', 'audit_log'],
};

export type OffboardingStatus = {
  workspaceId: string; state: 'pending' | 'running' | 'done' | 'cancelled'; requestedBy: string; requestedRole: 'owner' | 'operator'; reason: string | null;
  requestedAt: number; executeAfter: number; writeOffMinor: number; stepsDone: string[]; attempts: number; lastError: string | null; finishedAt: number | null;
};
type Row = {
  workspace_id: string; state: OffboardingStatus['state']; requested_by: string; requested_role: 'owner' | 'operator'; reason: string | null; requested_at: number; execute_after: number;
  write_off_minor: number; started_at: number | null; finished_at: number | null; steps_done: string; attempts: number; last_error: string | null; pseudonym: string | null;
};
const dto = (r: Row): OffboardingStatus => ({
  workspaceId: r.workspace_id, state: r.state, requestedBy: r.requested_by, requestedRole: r.requested_role, reason: r.reason, requestedAt: r.requested_at, executeAfter: r.execute_after,
  writeOffMinor: r.write_off_minor, stepsDone: r.steps_done ? r.steps_done.split(',') : [], attempts: r.attempts, lastError: r.last_error, finishedAt: r.finished_at,
});
const stub = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
const logRow = (env: Env, ws: string, actor: string, action: string, now: number, reason?: string | null, detail?: string) =>
  env.DB.prepare('INSERT INTO offboarding_log (at, workspace_id, actor, action, reason, detail) VALUES (?, ?, ?, ?, ?, ?)').bind(now, ws, actor, action, reason ?? null, detail ?? null);

export async function getOffboarding(env: Env, ws: string): Promise<OffboardingStatus | null> {
  const r = await env.DB.prepare('SELECT * FROM offboarding WHERE workspace_id = ?').bind(ws).first<Row>();
  return r ? dto(r) : null;
}
/** The status with its audit trail, newest last (what the operator console shows). */
export async function getOffboardingWithLog(env: Env, ws: string): Promise<(OffboardingStatus & { log: { at: number; actor: string; action: string; reason: string | null }[] }) | null> {
  const st = await getOffboarding(env, ws);
  if (!st) return null;
  const { results } = await env.DB.prepare('SELECT at, actor, action, reason FROM offboarding_log WHERE workspace_id = ? ORDER BY id DESC LIMIT 50').bind(ws).all<{ at: number; actor: string; action: string; reason: string | null }>();
  return { ...st, log: results.reverse() };
}
export async function listOffboardings(env: Env, state?: string): Promise<OffboardingStatus[]> {
  const q = state ? env.DB.prepare('SELECT * FROM offboarding WHERE state = ? ORDER BY execute_after LIMIT 200').bind(state) : env.DB.prepare('SELECT * FROM offboarding ORDER BY requested_at DESC LIMIT 200');
  return (await q.all<Row>()).results.map(dto);
}
/** True once a deletion has started: the workspace is being (or has been) erased, so late queue messages for it are dropped instead of retried. */
export async function isOffboarding(env: Env, ws: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM offboarding WHERE workspace_id = ? AND state IN ('running', 'done')").bind(ws).first());
}

/** The id the money records of a deleted workspace move to: HMAC-SHA-256 under a key derived (HKDF) from TOKEN_ENC_KEY, truncated to 128 bits. Null = no key (fail closed). */
export async function pseudonymFor(env: Env, ws: string): Promise<string | null> {
  const secret = env.TOKEN_ENC_KEY;
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
  if (existing?.state === 'running') return { ok: false, reason: 'already_running' };
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
    const detail = JSON.stringify({
      previous: { requested_role: existing.requested_role, requested_by: existing.requested_by, reason: existing.reason, execute_after: existing.execute_after, write_off_minor: existing.write_off_minor },
      new: { requested_role: 'operator', requested_by: a.actor, reason, execute_after: after, write_off_minor: writeOff },
      taken_over: takenOver, expedited,
    });
    const [upd] = await env.DB.batch([
      env.DB.prepare("UPDATE offboarding SET requested_role = 'operator', requested_by = ?, reason = ?, execute_after = ?, write_off_minor = ? WHERE workspace_id = ? AND state = 'pending'").bind(a.actor, reason, after, writeOff, a.workspaceId),
      // The log row is written only if the update above applied (the same batch, so a run that claimed the row in between leaves no false entry).
      env.DB.prepare("INSERT INTO offboarding_log (at, workspace_id, actor, action, reason, detail) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM offboarding WHERE workspace_id = ? AND state = 'pending' AND requested_by = ? AND requested_role = 'operator')")
        .bind(now, a.workspaceId, a.actor, takenOver ? 'taken_over' : 'operator_changed', reason, detail, a.workspaceId, a.actor),
    ]);
    if (!upd!.meta.changes) return { ok: false, reason: 'already_running' };
    return { ok: true, value: dto({ ...existing, requested_role: 'operator', requested_by: a.actor, reason, execute_after: after, write_off_minor: writeOff }) };
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
    logRow(env, a.workspaceId, a.actor, 'requested', now, a.reason, writeOff ? `write_off_minor=${writeOff}` : undefined),
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
  const res = await env.DB.prepare("UPDATE offboarding SET state = 'cancelled' WHERE workspace_id = ? AND state = 'pending'").bind(a.workspaceId).run();
  if (!res.meta.changes) return { ok: false, reason: 'already_running' }; // the run started between our read and our write
  await logRow(env, a.workspaceId, a.actor, 'cancelled', now, a.reason).run();
  return { ok: true };
}

/** Work in flight that a deletion must not cut off: an open refund, a card refund, or a payment still being confirmed. Null = clear to go. */
async function heldReason(env: Env, ws: string, now: number): Promise<string | null> {
  const q = (sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).first();
  if (await q("SELECT 1 FROM refund_requests WHERE workspace_id = ? AND state IN ('pending', 'processing', 'manual_payout', 'abandoning')", ws)) return 'open_refund';
  if (await q("SELECT 1 FROM card_refunds WHERE workspace_id = ? AND state IN ('planned', 'sending', 'calling', 'pending', 'uncertain', 'held')", ws)) return 'open_card_refund';
  const recent = now - 2 * 86_400_000;
  if (await q("SELECT 1 FROM topups WHERE workspace_id = ? AND state = 'pending' AND created_at > ?", ws, recent)) return 'payment_in_flight';
  if (await q("SELECT 1 FROM package_orders WHERE workspace_id = ? AND status IN ('pending') AND created_at > ?", ws, recent)) return 'payment_in_flight';
  if (await q("SELECT 1 FROM instapay_requests WHERE workspace_id = ? AND state IN ('awaiting_proof', 'under_review') AND created_at > ?", ws, recent - 5 * 86_400_000)) return 'payment_in_flight';
  return null;
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
      const stmts: D1PreparedStatement[] = [
        env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(pseudo, 'deleted workspace', now),
      ];
      for (const [t, col] of Object.entries(OFFBOARD_TABLES.delete)) stmts.push(env.DB.prepare(`DELETE FROM ${t} WHERE ${col} = ?`).bind(ws));
      for (const [t, k] of Object.entries(OFFBOARD_TABLES.keep)) {
        const sets = ['workspace_id = ?', ...k.people.map((c) => `${c} = ?`), ...k.clear.map((c) => `${c} = NULL`)];
        stmts.push(env.DB.prepare(`UPDATE ${t} SET ${sets.join(', ')} WHERE workspace_id = ?`).bind(pseudo, ...k.people.map(() => pseudo), ws));
      }
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
  if (done.size === 0) {
    const held = await heldReason(env, ws, now);
    if (held) {
      const first = row.last_error !== `held:${held}`;
      await env.DB.prepare("UPDATE offboarding SET last_error = ? WHERE workspace_id = ? AND state = 'pending'").bind(`held:${held}`, ws).run();
      if (first) alert('offboarding_held', { workspace: ws, reason: held });
      return 'held';
    }
  }
  const pseudo = await pseudonymFor(env, ws);
  if (!pseudo) {
    alert('offboarding_failed', { workspace: ws, error: 'no_key' });
    return 'failed';
  }
  // The claim is ONE conditional write: a request cancelled (or not yet due) since we read it is not claimed, and nothing irreversible runs.
  const claim = await env.DB.prepare(
    "UPDATE offboarding SET state = 'running', attempts = attempts + 1, pseudonym = ?, started_at = coalesce(started_at, ?) WHERE workspace_id = ? AND state IN ('pending', 'running') AND execute_after <= ?",
  ).bind(pseudo, now, ws, now).run();
  if (!claim.meta.changes) return 'skipped';
  if (row.state === 'pending') await logRow(env, ws, 'system', 'started', now).run();
  for (const step of STEPS) {
    if (done.has(step)) continue;
    await hooks.beforeStep?.(step);
    // Re-checked before EVERY step: a cancel that lands mid-run stops the next (irreversible) step.
    const live = await env.DB.prepare("SELECT 1 FROM offboarding WHERE workspace_id = ? AND state = 'running'").bind(ws).first();
    if (!live) return 'skipped';
    try {
      const detail = await runStep(env, ws, step, pseudo, now);
      done.add(step);
      await env.DB.batch([
        env.DB.prepare('UPDATE offboarding SET steps_done = ?, last_error = NULL WHERE workspace_id = ?').bind(STEPS.filter((s) => done.has(s)).join(','), ws),
        logRow(env, ws, 'system', 'step_done', now, null, detail ? `${step} ${detail}` : step),
      ]);
    } catch (err) {
      const unfinished = err instanceof Unfinished;
      await env.DB.prepare('UPDATE offboarding SET last_error = ? WHERE workspace_id = ?').bind(unfinished ? `unfinished:${step}` : `${step}:${errClass(err)}`, ws).run();
      if (!unfinished) alert('offboarding_failed', { workspace: ws, step, error: errClass(err) });
      return unfinished ? 'unfinished' : 'failed';
    }
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE offboarding SET state = 'done', finished_at = ?, last_error = NULL WHERE workspace_id = ?").bind(now, ws),
    logRow(env, ws, 'system', 'completed', now),
  ]);
  console.log(JSON.stringify({ audit: 'offboarding_completed', workspace: ws }));
  return 'done';
}

/** The daily pass (and the operator's "run now"): every due or interrupted deletion, one at a time. */
export async function runDueOffboardings(env: Env, now = Date.now()): Promise<{ processed: number; failed: number; held: number }> {
  const due = (await env.DB.prepare("SELECT workspace_id FROM offboarding WHERE state IN ('pending', 'running') AND execute_after <= ? ORDER BY execute_after LIMIT 20").bind(now).all<{ workspace_id: string }>()).results;
  const out = { processed: 0, failed: 0, held: 0 };
  for (const { workspace_id } of due) {
    const r = await runOffboarding(env, workspace_id, now);
    if (r === 'done') out.processed++;
    else if (r === 'failed' || r === 'unfinished') out.failed++;
    else if (r === 'held') out.held++;
  }
  return out;
}
