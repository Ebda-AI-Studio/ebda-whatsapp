/**
 * InstaPay auto-confirm for the chat service (plan 2026-11-14 C3-C5; rulings INSTAPAY-1..7 and INSTAPAY-CLEAN-1, docs/rulings/INSTAPAY-AUTO-1.md).
 *
 * A merchant who paid a package or a top-up by InstaPay and uploaded the proof gets it confirmed in minutes IF every check passes; otherwise nothing changes
 * and the request waits for a person exactly as before. The model only READS the proof into a typed object (instapay-reader.ts); `decideInstapay` (foundation,
 * pure) decides; this file owns the storage, the activation and the revert. Money rules:
 *  - integer piastres only; the expected amount comes from the server (package price / the stored top-up amount), never from the proof;
 *  - ONE decision per request: `instapay_auto_confirmations.request_id` is UNIQUE and so is its idempotency key, a replay returns the stored row;
 *  - the platform-global duplicate index (INSTAPAY_DEDUPE_DB, shared with the Store) is claimed BEFORE the decision; a claim this call made is released if the
 *    activation fails, a claim that "needs a person" stays held, a revert BURNS it;
 *  - the request is confirmed by the same guarded UPDATE the operator path uses (CONFIRM_CLAIM_SQL) and granted through the same `grant()` (idempotent by reference);
 *  - revert ("not received", from the digest tap or the operator console): back to unpaid with a 48 h grace, the credits THAT payment granted and nobody used are
 *    removed (top-up wallet credits and package AI credits), consumed credits are never clawed back, nothing goes negative, every step idempotent under its own ref.
 * Mode `off` (default) and `shadow` never activate anything; only `live` does, and only for a workspace whose own switch is on.
 */
import { decideInstapay, type DecisionInput, type ReasonCode } from '../../../foundation/instapay-decision';
import { D1DuplicateIndex, normalizeReferenceKey, type ClaimResult, type D1Like, type DuplicateIndex } from '../../../foundation/instapay-dedupe';
import { parseReceiptExtraction, type ParsedExtraction, type ReceiptExtract } from '../../../foundation/instapay-extract';
import { autoConfirmKey, firstPaymentCapMinor, isCleanPayment, nextAutoState, revertGraceUntil, revertKey, type AutoEvent, type AutoState } from '../../../foundation/instapay-state';
import { brandPack } from '../../brand';
import type { Env } from '../../env';
import { billingAudit, PLATFORM_WORKSPACE } from '../audit-reason';
import { announceSubscription } from './subscriptions';
import { alert } from '../observability';
import { adjustmentThreshold } from './operator';
import { planPurchase } from './package-orders';
import { proofReaderAvailable, readProofForAutoConfirm } from './instapay-reader';
import { CONFIRM_CLAIM_SQL, NO_REF_WINDOW_MS, getRequestRow, grant, normaliseBankRef, orderMatches, type InstapayRow } from './instapay';
import { notifyWaiting } from './instapay-notify';

export type AutoMode = 'off' | 'shadow' | 'live';
export const SYSTEM_ACTOR = 'system:auto-confirm';
/** A decision that stays `pending_decision` longer than this was abandoned (the isolate died): the sweep may take it over. Every step after the claim is idempotent. */
export const DECISION_LEASE_MS = 5 * 60_000;
/** The proof must have been waiting this long before the sweep picks a request up that no trigger decided. */
export const SWEEP_AFTER_MS = 10 * 60_000;

const stubOf = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

// ---- switches (NEVER-stale: a money switch is read from D1 on every decision, no cache anywhere, so no invalidation exists or is needed) -------------------

export async function getAutoMode(env: Env): Promise<AutoMode> {
  const r = await env.DB.prepare("SELECT value FROM instapay_auto_settings WHERE key = 'mode'").first<{ value: string }>();
  return r?.value === 'shadow' || r?.value === 'live' ? r.value : 'off';
}
export async function workspaceAutoEnabled(env: Env, workspaceId: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT disabled_at FROM instapay_auto_workspace WHERE workspace_id = ?').bind(workspaceId).first<{ disabled_at: number | null }>();
  return !r || r.disabled_at === null;
}
export type SwitchResult = { ok: true } | { ok: false; reason: 'reason_required' | 'invalid_mode' };
export async function setAutoMode(env: Env, a: { mode: string; actor: string; reason: string }, now = Date.now()): Promise<SwitchResult> {
  if (a.mode !== 'off' && a.mode !== 'shadow' && a.mode !== 'live') return { ok: false, reason: 'invalid_mode' };
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  const before = await getAutoMode(env);
  await env.DB.prepare("INSERT INTO instapay_auto_settings (key, value, updated_by, updated_at) VALUES ('mode', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
    .bind(a.mode, a.actor, now).run();
  await billingAudit(env, { at: now, actor: a.actor, action: 'instapay_auto_mode_changed', workspaceId: PLATFORM_WORKSPACE, before: { mode: before }, after: { mode: a.mode }, reason });
  return { ok: true };
}
export async function setWorkspaceAuto(env: Env, a: { workspaceId: string; enabled: boolean; actor: string; reason: string }, now = Date.now()): Promise<SwitchResult> {
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  await env.DB.prepare('INSERT INTO instapay_auto_workspace (workspace_id, disabled_at, actor, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET disabled_at = excluded.disabled_at, actor = excluded.actor, updated_at = excluded.updated_at')
    .bind(a.workspaceId, a.enabled ? null : now, a.actor, now).run();
  await billingAudit(env, { at: now, actor: a.actor, action: 'instapay_auto_workspace_toggled', workspaceId: a.workspaceId, after: { enabled: a.enabled }, reason });
  return { ok: true };
}

// ---- readiness + the duplicate index ---------------------------------------------------------------------------------------------------------------------

const payeeHandle = (env: Env): string | null => brandPack(env.BRAND).instapayPayee?.(env as unknown as Record<string, string | undefined>)?.handle ?? null;

/** What auto-confirm needs to run at all. Anything missing = it refuses (fail closed) and `/health` says which. */
export function instapayAutoReady(env: Env): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!env.INSTAPAY_DEDUPE_DB) missing.push('INSTAPAY_DEDUPE_DB');
  if (!env.INSTAPAY_BRIDGE_SECRET || env.INSTAPAY_BRIDGE_SECRET.length < 16) missing.push('INSTAPAY_BRIDGE_SECRET');
  if (!/^https:\/\/\S+$/.test(env.BRAIN_BRIDGE_URL ?? '')) missing.push('BRAIN_BRIDGE_URL');
  if (!payeeHandle(env)) missing.push('INSTAPAY_PAYEE_HANDLE');
  if (!proofReaderAvailable(env)) missing.push('AI');
  return { ready: missing.length === 0, missing };
}

export const getDuplicateIndex = (env: Env): DuplicateIndex | null => (env.INSTAPAY_DEDUPE_DB ? new D1DuplicateIndex(env.INSTAPAY_DEDUPE_DB as unknown as D1Like) : null);

// ---- rows ---------------------------------------------------------------------------------------------------------------------------------------------------

export type AutoRow = {
  id: string; request_id: string; workspace_id: string; state: AutoState; verdict: string | null; reasons_json: string; amount_minor: number | null; expected_amount_minor: number | null;
  is_first_payment: number | null; extracted_json: string | null; confirmed_at: number | null; digest_sent_at: number | null; reverted_at: number | null; reverted_by: string | null;
  grace_until: number | null; credits_removed_minor: number | null; credits_used_minor: number | null; ai_credits_removed: number | null; ai_credits_used: number | null;
  waiting_notified_at: number | null; created_at: number; updated_at: number;
};
export const AUTO_COLS = 'id, request_id, workspace_id, state, verdict, reasons_json, amount_minor, expected_amount_minor, is_first_payment, extracted_json, confirmed_at, digest_sent_at, reverted_at, reverted_by, grace_until, credits_removed_minor, credits_used_minor, ai_credits_removed, ai_credits_used, waiting_notified_at, created_at, updated_at';
const autoByRequest = (env: Env, requestId: string) => env.DB.prepare(`SELECT ${AUTO_COLS} FROM instapay_auto_confirmations WHERE request_id = ?`).bind(requestId).first<AutoRow>();
const reasonsOf = (r: AutoRow): ReasonCode[] => { try { return JSON.parse(r.reasons_json) as ReasonCode[]; } catch { return []; } };
export type AutoOutcome = { state: AutoState; reasons: ReasonCode[] };
const outcome = (r: AutoRow): AutoOutcome => ({ state: r.state, reasons: reasonsOf(r) });

type Final = { verdict: string; reasons: ReasonCode[]; amountMinor?: number; expectedMinor?: number; isFirst?: boolean; extracted?: unknown; confirmedAt?: number };
/** One conditional write: the first finisher wins, a second sees `false`. The target state comes from the foundation table, never typed here. */
async function finalize(env: Env, autoId: string, event: Extract<AutoEvent, 'decide_auto' | 'decide_human' | 'activation_failed'>, f: Final, now: number): Promise<boolean> {
  const to = nextAutoState('pending_decision', event);
  if (to === 'illegal') throw new Error('illegal auto-confirm transition');
  const res = await env.DB.prepare(
    `UPDATE instapay_auto_confirmations SET state = ?, verdict = ?, reasons_json = ?, amount_minor = ?, expected_amount_minor = ?, is_first_payment = ?, extracted_json = ?, confirmed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending_decision'`,
  ).bind(to, f.verdict, JSON.stringify(f.reasons), f.amountMinor ?? null, f.expectedMinor ?? null, f.isFirst === undefined ? null : f.isFirst ? 1 : 0, f.extracted === undefined ? null : JSON.stringify(f.extracted), f.confirmedAt ?? null, now, autoId).run();
  return res.meta.changes > 0;
}

// ---- inputs of the decision -----------------------------------------------------------------------------------------------------------------------

/** A package's price per month, in piastres (a yearly package divides by its months). Null = no such package. */
async function monthlyPriceOf(env: Env, packageId: string): Promise<number | null> {
  const p = await env.DB.prepare('SELECT price_minor, period_months FROM packages WHERE id = ?').bind(packageId).first<{ price_minor: number; period_months: number }>();
  return p ? Math.floor(p.price_minor / Math.max(1, p.period_months)) : null;
}
/** The package the workspace is on RIGHT NOW (its plan must still be running), as a monthly price; null = no plan. */
async function currentMonthlyPrice(env: Env, workspaceId: string, now: number): Promise<number | null> {
  const s = await env.DB.prepare("SELECT package_id FROM workspace_subscriptions WHERE workspace_id = ? AND period_end > ? AND status IN ('active', 'trialing', 'cancelled')").bind(workspaceId, now).first<{ package_id: string }>();
  return s ? monthlyPriceOf(env, s.package_id) : null;
}

/** INSTAPAY-CLEAN-1: the workspace has had no earlier confirmed InstaPay payment that is "clean" (human-confirmed, or auto-confirmed and listed in a digest that was SENT). */
async function isFirstPayment(env: Env, workspaceId: string, exceptId: string, now: number): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT r.decided_by, r.decided_at, r.reverted_at, a.digest_sent_at FROM instapay_requests r LEFT JOIN instapay_auto_confirmations a ON a.request_id = r.id
      WHERE r.workspace_id = ? AND r.state = 'confirmed' AND r.id <> ?`,
  ).bind(workspaceId, exceptId).all<{ decided_by: string | null; decided_at: number | null; reverted_at: number | null; digest_sent_at: number | null }>();
  return !results.some((p) => isCleanPayment({ confirmedBy: p.decided_by === SYSTEM_ACTOR ? 'auto' : 'human', confirmedAt: p.decided_at ?? 0, digestSentAt: p.digest_sent_at, revertedAt: p.reverted_at }, now));
}

type Expected = { amountMinor: number; capMonthlyMinor: number | null; reviewKind: boolean };
async function expectedFor(env: Env, r: InstapayRow, now: number): Promise<Expected> {
  if (r.kind === 'topup') return { amountMinor: r.amount_minor, capMonthlyMinor: await currentMonthlyPrice(env, r.workspace_id, now), reviewKind: false };
  const plan = await planPurchase(env, r.workspace_id, r.package_id ?? '', now);
  if (!plan.ok) return { amountMinor: r.amount_minor, capMonthlyMinor: null, reviewKind: true };
  // Only a purchase that STARTS a period is automatic. A renewal queued behind the running period, an upgrade or a queued switch changes someone's running plan: a person looks.
  const running = await env.DB.prepare("SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND package_id = ? AND period_end > ? AND status IN ('active', 'trialing')").bind(r.workspace_id, r.package_id, now).first();
  return { amountMinor: plan.amountMinor, capMonthlyMinor: await monthlyPriceOf(env, r.package_id ?? ''), reviewKind: plan.kind !== 'purchase' || !!running };
}

// ---- the decision ---------------------------------------------------------------------------------------------------------------------------------------------

const orderReasons = (xs: Iterable<ReasonCode>): ReasonCode[] => {
  const set = new Set(xs);
  return (['KILL_GLOBAL', 'KILL_STORE', 'SHADOW_MODE'] as const).filter((c) => set.has(c));
};

/**
 * Decides ONE request and, in live mode with every check passing, confirms and grants it. Never throws for a business outcome; a replay returns the stored row.
 * `now` is an input (never read inside the decision).
 */
export async function autoConfirmInstapay(env: Env, requestId: string, now = Date.now()): Promise<AutoOutcome> {
  const r = await getRequestRow(env, requestId);
  if (!r) return { state: 'failed', reasons: [] };
  const id = crypto.randomUUID();
  const ins = await env.DB.prepare(
    "INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'pending_decision', ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING",
  ).bind(id, r.id, r.workspace_id, autoConfirmKey('chat', r.id), now, now).run();
  let autoId = id;
  if (!ins.meta.changes) {
    const existing = (await autoByRequest(env, r.id))!;
    if (existing.state !== 'pending_decision') return outcome(existing); // a replay never re-decides or re-activates
    // A decision that is still pending is either running right now or was abandoned: only an abandoned one (lease over) may be taken over.
    const took = await env.DB.prepare("UPDATE instapay_auto_confirmations SET updated_at = ? WHERE id = ? AND state = 'pending_decision' AND updated_at <= ?").bind(now, existing.id, now - DECISION_LEASE_MS).run();
    if (!took.meta.changes) return outcome(existing);
    autoId = existing.id;
  }
  try {
    return await decide(env, r, autoId, now);
  } catch (err) {
    // Anything unexpected before the money moved fails CLOSED: a person decides. (A confirm that already committed is handled inside `decide`.)
    const cur = await getRequestRow(env, r.id);
    if (cur?.state === 'confirmed' && cur.decided_by === SYSTEM_ACTOR) {
      alert('instapay_grant_failed', { severity: 'P1', id: r.id, workspace: r.workspace_id, error: errName(err) });
      await finalize(env, autoId, 'activation_failed', { verdict: 'activation_failed', reasons: [] }, now);
    } else {
      await finalize(env, autoId, 'decide_human', { verdict: 'needs_human', reasons: ['EXTRACT_INCOMPLETE'] }, now);
      alert('instapay_auto_error', { id: r.id, workspace: r.workspace_id, error: errName(err) }); // info: the request is simply waiting for a person
    }
    const row = (await autoByRequest(env, r.id))!;
    if (row.state === 'needs_human') await notifyWaiting(env, row, r).catch(() => undefined);
    return outcome(row);
  }
}

async function decide(env: Env, r: InstapayRow, autoId: string, now: number): Promise<AutoOutcome> {
  const done = async (event: 'decide_human' | 'decide_auto' | 'activation_failed', f: Final, notify: boolean): Promise<AutoOutcome> => {
    await finalize(env, autoId, event, f, now);
    const row = (await autoByRequest(env, r.id))!;
    if (notify && row.state === 'needs_human') await notifyWaiting(env, row, r).catch(() => undefined);
    return outcome(row);
  };
  const mode = await getAutoMode(env);
  const wsOn = await workspaceAutoEnabled(env, r.workspace_id);
  const ready = instapayAutoReady(env);

  // Not eligible at all: nothing is read, nothing is claimed.
  if (r.state !== 'under_review' || !r.proof_key) return done('decide_human', { verdict: 'skipped:not_reviewable', reasons: [] }, false);
  if (r.held_reason) return done('decide_human', { verdict: 'skipped:held', reasons: [r.held_reason === 'duplicate_image' ? 'DUPLICATE_IMAGE' : 'DUPLICATE_REFERENCE'] }, false); // the existing hold already alerted
  if (mode === 'off' || !ready.ready || !wsOn) {
    const gates: ReasonCode[] = [];
    if (mode === 'off' || !ready.ready) gates.push('KILL_GLOBAL');
    if (mode === 'shadow') gates.push('SHADOW_MODE');
    if (!wsOn) gates.push('KILL_STORE');
    return done('decide_human', { verdict: 'needs_human', reasons: orderReasons(gates) }, mode !== 'off'); // off = the feature is dormant: no notice, the flow is exactly as before
  }

  const expected = await expectedFor(env, r, now);
  const first = await isFirstPayment(env, r.workspace_id, r.id, now);
  const obj = await env.MEDIA.get(r.proof_key);
  const bytes = obj ? await obj.arrayBuffer() : null;
  const parsed: ParsedExtraction = (bytes && r.proof_mime ? await readProofForAutoConfirm(env, bytes, r.proof_mime) : null) ?? parseReceiptExtraction(null);
  const extract: ReceiptExtract | null = parsed.extract;

  // The duplicate index is claimed BEFORE the decision. No index, an index that throws, or an unreadable reference = a duplicate (fail closed).
  const index = getDuplicateIndex(env);
  const refKey = extract ? normalizeReferenceKey(extract.reference) : null;
  let claim: ClaimResult | null = null;
  let duplicate: DecisionInput['duplicate'] = 'none';
  if (extract) {
    if (!index || !refKey || !r.proof_sha256) duplicate = 'both';
    else {
      try {
        claim = await index.claim({ referenceKey: refKey, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id });
      } catch (err) {
        alert('instapay_auto_error', { id: r.id, workspace: r.workspace_id, error: errName(err), where: 'dedupe' });
        duplicate = 'both';
      }
      if (claim === 'duplicate_reference') duplicate = 'reference';
      if (claim === 'duplicate_image') duplicate = 'image';
    }
    // The existing per-product unique index on bank_ref stays the second layer: a reference a person already confirmed (before the shared index existed) is a duplicate too.
    const bank = normaliseBankRef(extract.reference);
    const other = bank ? await env.DB.prepare("SELECT id FROM instapay_requests WHERE (bank_ref = ?1 OR pending_bank_ref = ?1) AND id <> ?2 AND state NOT IN ('rejected', 'expired') LIMIT 1").bind(bank, r.id).first() : null;
    if (other) duplicate = duplicate === 'image' || duplicate === 'both' ? 'both' : 'reference';
  }
  const claimedHere = claim === 'claimed';
  const release = async () => {
    if (claimedHere && index && extract && refKey && r.proof_sha256) await index.release({ referenceKey: refKey, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id }).catch(() => undefined);
  };

  const input: DecisionInput = {
    extract,
    expected: { amountMinor: expected.amountMinor, payeeHandle: payeeHandle(env) ?? '' },
    now, mode, storeEnabled: wsOn, isFirstPayment: first,
    firstPaymentCapMinor: firstPaymentCapMinor({ monthlyPriceMinor: expected.capMonthlyMinor }),
    // The two-approver threshold ALWAYS wins (a threshold of 0 sends a kind a person must review straight to a person).
    dualControlThresholdMinor: expected.reviewKind ? 0 : adjustmentThreshold(env),
    duplicate,
    flags: parsed.flags,
  };
  const decision = decideInstapay(input);
  const mask = extract ? { amountMinor: extract.amountMinor, reference: extract.reference, transferredAt: extract.transferredAt, flags: parsed.flags } : { flags: parsed.flags };
  const base = { amountMinor: extract?.amountMinor, expectedMinor: expected.amountMinor, isFirst: first, extracted: mask };

  if (decision.verdict !== 'auto_confirm') {
    // The would-be verdict of a shadow decision is kept (so the rollout can compare it with what a person did).
    const would = mode === 'shadow' ? decideInstapay({ ...input, mode: 'live' }).verdict : 'needs_human';
    return done('decide_human', { ...base, verdict: would, reasons: decision.reasons }, true);
  }

  // ---- live + every check passed: confirm, then grant ----
  const bankRef = normaliseBankRef(extract!.reference);
  if (!bankRef || !(await orderMatches(env, r))) {
    await release();
    alert('instapay_amount_mismatch', { severity: 'P1', id: r.id, workspace: r.workspace_id });
    return done('decide_human', { ...base, verdict: 'needs_human', reasons: ['AMOUNT_MISMATCH'] }, true);
  }
  let claimed: D1Result | null = null;
  try {
    claimed = await env.DB.prepare(CONFIRM_CLAIM_SQL).bind(r.id, SYSTEM_ACTOR, now, bankRef, 0, r.workspace_id, r.amount_minor, now - NO_REF_WINDOW_MS).run();
  } catch (err) {
    if (!/UNIQUE/i.test(errMsg(err))) {
      await release();
      throw err;
    }
  }
  if (!claimed?.meta.changes) {
    // Lost the race (a person decided, the reference was taken between the check and the write): compensate and wait for a person.
    await release();
    return done('decide_human', { ...base, verdict: 'needs_human', reasons: ['DUPLICATE_REFERENCE'] }, true);
  }
  await billingAudit(env, { at: now, actor: SYSTEM_ACTOR, action: 'instapay_auto_confirmed', workspaceId: r.workspace_id, after: { id: r.id, kind: r.kind, amountMinor: r.amount_minor, isFirstPayment: first } });
  try {
    await grant(env, (await getRequestRow(env, r.id))!, now);
  } catch (err) {
    // Confirmed but not granted: the daily repair finishes the grant (idempotent), a person is told now. The auto row says `failed`, never a half state.
    alert('instapay_grant_failed', { severity: 'P1', id: r.id, workspace: r.workspace_id, error: errName(err) });
    return done('activation_failed', { ...base, verdict: 'activation_failed', reasons: [] }, false);
  }
  if ((await getRequestRow(env, r.id))?.granted_at == null) {
    // An offboarded workspace: nothing was granted (credit_after_offboard, P1, was raised by the grant path) and nobody is messaged.
    return done('activation_failed', { ...base, verdict: 'not_granted', reasons: [] }, false);
  }
  return done('decide_auto', { ...base, verdict: 'auto_confirm', reasons: [], confirmedAt: now }, false);
}
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The trigger after a proof is stored (and the sweep): never throws; a failure leaves the request waiting for a person with a visible row. */
export async function triggerAutoConfirm(env: Env, requestId: string, now = Date.now()): Promise<void> {
  try {
    if ((await getAutoMode(env)) === 'off') return; // dormant: not even a row, the request is exactly as it was before this feature
    await autoConfirmInstapay(env, requestId, now);
  } catch (err) {
    alert('instapay_auto_error', { id: requestId, error: errName(err), where: 'trigger' });
    // Never an orphan: write the needs_human row so the sweep does not retry forever and the operator list shows it.
    const r = await getRequestRow(env, requestId).catch(() => null);
    if (r) {
      await env.DB.prepare(
        "INSERT INTO instapay_auto_confirmations (id, request_id, workspace_id, state, verdict, reasons_json, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, 'needs_human', 'needs_human', '[\"EXTRACT_INCOMPLETE\"]', ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING",
      ).bind(crypto.randomUUID(), r.id, r.workspace_id, autoConfirmKey('chat', r.id), now, now).run().catch(() => undefined);
    }
  }
}

/** The daily repair: a request under review with a proof for 10+ minutes and no decision row (a trigger that never ran) is decided now; an abandoned decision is resumed. */
export async function sweepAutoConfirm(env: Env, now = Date.now()): Promise<{ decided: number }> {
  if ((await getAutoMode(env)) === 'off') return { decided: 0 };
  const { results } = await env.DB.prepare(
    `SELECT r.id FROM instapay_requests r LEFT JOIN instapay_auto_confirmations a ON a.request_id = r.id
      WHERE r.state = 'under_review' AND r.proof_key IS NOT NULL AND r.held_reason IS NULL AND r.proof_at <= ?1
        AND (a.id IS NULL OR (a.state = 'pending_decision' AND a.updated_at <= ?2)) ORDER BY r.proof_at, r.id LIMIT 100`,
  ).bind(now - SWEEP_AFTER_MS, now - DECISION_LEASE_MS).all<{ id: string }>();
  for (const x of results) await triggerAutoConfirm(env, x.id, now);
  return { decided: results.length };
}

// ---- revert ------------------------------------------------------------------------------------------------------------------------------------------------------

export type RevertResult =
  | { ok: true; result: 'reverted' | 'already_reverted'; graceUntil: number; creditsRemovedMinor: number; creditsUsedMinor: number; aiCreditsRemoved: number; aiCreditsUsed: number }
  | { ok: false; reason: 'not_found' | 'not_auto_confirmed' | 'reason_required' };

const doneRevert = (r: AutoRow, result: 'reverted' | 'already_reverted'): RevertResult => ({
  ok: true, result, graceUntil: r.grace_until ?? 0, creditsRemovedMinor: r.credits_removed_minor ?? 0, creditsUsedMinor: r.credits_used_minor ?? 0, aiCreditsRemoved: r.ai_credits_removed ?? 0, aiCreditsUsed: r.ai_credits_used ?? 0,
});

/**
 * "Not received". `id` is the REQUEST id. Only an auto-confirmed payment reverts (a person-confirmed one is refused); the state flips first with one conditional UPDATE
 * (so racing taps end in one winner), every effect after it is idempotent under its own ref, and a revert that died half way is finished by the next call (the amounts
 * are written LAST, `credits_removed_minor IS NULL` means unfinished).
 */
export async function revertAutoConfirmed(env: Env, a: { id: string; actor: string; reason: string }, now = Date.now()): Promise<RevertResult> {
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  let row = await autoByRequest(env, a.id);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.state === 'auto_confirmed') {
    const to = nextAutoState('auto_confirmed', 'revert');
    if (to === 'illegal') throw new Error('illegal auto-confirm transition');
    const grace = revertGraceUntil(now);
    const flipped = await env.DB.prepare("UPDATE instapay_auto_confirmations SET state = ?, reverted_at = ?, reverted_by = ?, grace_until = ?, updated_at = ? WHERE id = ? AND state = 'auto_confirmed'").bind(to, now, a.actor, grace, now, row.id).run();
    row = (await autoByRequest(env, a.id))!;
    if (!flipped.meta.changes) {
      if (row.state !== 'reverted') return { ok: false, reason: 'not_auto_confirmed' };
      // A racing tap flipped it: fall through to the finishing path below (idempotent), reporting `already_reverted`.
    } else {
      await finishRevert(env, row, a.actor, reason, now);
      return doneRevert((await autoByRequest(env, a.id))!, 'reverted');
    }
  }
  if (row.state !== 'reverted') return { ok: false, reason: 'not_auto_confirmed' };
  if (row.credits_removed_minor === null) await finishRevert(env, row, a.actor, reason, now); // the first revert died before it finished: complete it
  return doneRevert((await autoByRequest(env, a.id))!, 'already_reverted');
}

/** Every effect of a revert, each idempotent, in the order that is safest to retry. */
async function finishRevert(env: Env, row: AutoRow, actor: string, reason: string, now: number): Promise<void> {
  const r = (await getRequestRow(env, row.request_id))!;
  const grace = row.grace_until ?? revertGraceUntil(row.reverted_at ?? now);
  const note = `instapay not received (${actor})`;
  let removedMinor = 0, usedMinor = 0, aiRemoved = 0, aiUsed = 0;

  if (r.kind === 'topup') {
    const t = await env.DB.prepare('SELECT amount_minor FROM topups WHERE order_id = ?').bind(r.id).first<{ amount_minor: number }>();
    if (t && r.granted_at !== null) {
      const out = await stubOf(env, r.workspace_id).revertInstapayWallet({ creditedMinor: t.amount_minor, ref: `${revertKey('chat', r.id)}:wallet`, actor, note }, now);
      removedMinor = out.removedMinor;
      usedMinor = out.usedMinor;
    }
  } else {
    const order = await env.DB.prepare('SELECT package_id, owns_running FROM package_orders WHERE order_id = ?').bind(r.id).first<{ package_id: string; owns_running: number }>();
    const sub = await env.DB.prepare('SELECT package_id, period_start FROM workspace_subscriptions WHERE workspace_id = ?').bind(r.workspace_id).first<{ package_id: string; period_start: number }>();
    if (order && sub && order.owns_running === 1 && sub.package_id === order.package_id && r.granted_at !== null) {
      const out = await stubOf(env, r.workspace_id).revertInstapayAiCredits({ periodStart: sub.period_start, packageId: order.package_id, ref: `${revertKey('chat', r.id)}:ai`, actor, note }, now);
      aiRemoved = out.removedCredits;
      aiUsed = out.usedCredits;
      // The 48 h unpaid grace: the plan stays fully in effect until `grace`, then the period ends there (so service stops exactly then, unless a new confirmed payment arrives).
      // Only the period THIS payment started is shortened, and never lengthened.
      const clamp = await env.DB.prepare(
        `UPDATE workspace_subscriptions SET payment_unconfirmed_until = ?2, period_end = min(period_end, ?2), version = version + 1, updated_at = ?3
          WHERE workspace_id = ?1 AND package_id = ?4 AND period_end > ?3 AND status IN ('active', 'trialing') AND payment_unconfirmed_until IS NULL
            AND EXISTS (SELECT 1 FROM package_orders WHERE order_id = ?5 AND owns_running = 1)`,
      ).bind(r.workspace_id, grace, now, order.package_id, r.id).run();
      if (clamp.meta.changes) await announceSubscription(env, r.workspace_id, now).catch((err) => alert('entitlement_push_failed', { workspace: r.workspace_id, error: errName(err) }));
    } else if (order && r.granted_at !== null) {
      // A payment that did not start the running period (a queued one): nothing automatic can undo it safely.
      alert('instapay_confirmed_not_granted', { severity: 'P1', id: r.id, workspace: r.workspace_id, note: 'auto revert of a queued package payment needs a person' });
    }
  }

  // The reference and the image can never auto-confirm again; the request is marked; a reverted merchant goes back to manual review until the owner switches them on.
  const index = getDuplicateIndex(env);
  const bank = r.bank_ref ? normalizeReferenceKey(r.bank_ref) : null;
  if (index && bank && r.proof_sha256) await index.burn({ referenceKey: bank, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id });
  else alert('instapay_auto_error', { id: r.id, workspace: r.workspace_id, where: 'burn_unavailable' });
  await env.DB.prepare('UPDATE instapay_requests SET reverted_at = coalesce(reverted_at, ?) WHERE id = ?').bind(row.reverted_at ?? now, r.id).run();
  await setWorkspaceAuto(env, { workspaceId: r.workspace_id, enabled: false, actor, reason: 'reverted payment' }, now);
  await billingAudit(env, { at: now, actor, action: 'instapay_auto_reverted', workspaceId: r.workspace_id, after: { id: r.id, graceUntil: grace }, reason });
  await billingAudit(env, { at: now, actor, action: 'instapay_auto_reverted_credits', workspaceId: r.workspace_id, after: { id: r.id, creditsRemovedMinor: removedMinor, creditsUsedMinor: usedMinor, aiCreditsRemoved: aiRemoved, aiCreditsUsed: aiUsed } });
  // Amounts LAST: this is the completion marker.
  await env.DB.prepare('UPDATE instapay_auto_confirmations SET credits_removed_minor = ?, credits_used_minor = ?, ai_credits_removed = ?, ai_credits_used = ?, updated_at = ? WHERE id = ? AND credits_removed_minor IS NULL')
    .bind(removedMinor, usedMinor, aiRemoved, aiUsed, now, row.id).run();
}

// ---- operator / merchant views ------------------------------------------------------------------------------------------------------------------------------

export type AutoDto = {
  requestId: string; workspaceId: string; workspaceName: string | null; kind: 'package' | 'topup' | null; state: AutoState; verdict: string | null; reasons: ReasonCode[]; amountMinor: number | null; expectedAmountMinor: number | null;
  isFirstPayment: boolean | null; confirmedAt: number | null; digestSentAt: number | null; revertedAt: number | null; graceUntil: number | null; creditsRemovedMinor: number | null; creditsUsedMinor: number | null;
  aiCreditsRemoved: number | null; aiCreditsUsed: number | null; createdAt: number;
};
const AUTO_STATES: readonly string[] = ['pending_decision', 'auto_confirmed', 'needs_human', 'reverted', 'failed'];
export async function listAutoConfirmations(env: Env, state?: string): Promise<AutoDto[]> {
  const ok = state && AUTO_STATES.includes(state);
  const { results } = await env.DB.prepare(
    `SELECT ${AUTO_COLS.split(', ').map((c) => `a.${c}`).join(', ')}, r.kind AS kind, w.name AS workspace_name FROM instapay_auto_confirmations a
       LEFT JOIN instapay_requests r ON r.id = a.request_id LEFT JOIN workspaces w ON w.id = a.workspace_id ${ok ? 'WHERE a.state = ?' : ''} ORDER BY a.created_at DESC LIMIT 200`,
  ).bind(...(ok ? [state] : [])).all<AutoRow & { kind: 'package' | 'topup' | null; workspace_name: string | null }>();
  return results.map((a) => ({
    requestId: a.request_id, workspaceId: a.workspace_id, workspaceName: a.workspace_name, kind: a.kind, state: a.state, verdict: a.verdict, reasons: reasonsOf(a), amountMinor: a.amount_minor, expectedAmountMinor: a.expected_amount_minor,
    isFirstPayment: a.is_first_payment === null ? null : a.is_first_payment === 1, confirmedAt: a.confirmed_at, digestSentAt: a.digest_sent_at, revertedAt: a.reverted_at, graceUntil: a.grace_until,
    creditsRemovedMinor: a.credits_removed_minor, creditsUsedMinor: a.credits_used_minor, aiCreditsRemoved: a.ai_credits_removed, aiCreditsUsed: a.ai_credits_used, createdAt: a.created_at,
  }));
}

/** The merchant's view of a revert: the newest reverted payment whose 48 h grace is still running (derived from the row, so one per request and never "unseen"). */
export async function revertNotice(env: Env, workspaceId: string, now = Date.now()): Promise<{ requestId: string; kind: 'package' | 'topup'; graceUntil: number } | null> {
  const r = await env.DB.prepare(
    `SELECT a.request_id, a.grace_until, r.kind FROM instapay_auto_confirmations a JOIN instapay_requests r ON r.id = a.request_id
      WHERE a.workspace_id = ? AND a.state = 'reverted' AND a.grace_until > ? ORDER BY a.grace_until DESC LIMIT 1`,
  ).bind(workspaceId, now).first<{ request_id: string; grace_until: number; kind: 'package' | 'topup' }>();
  return r ? { requestId: r.request_id, kind: r.kind, graceUntil: r.grace_until } : null;
}
