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
import { REASON_ORDER, decideInstapay, type DecisionInput, type ReasonCode } from '../../../foundation/instapay-decision';
import { D1DuplicateIndex, normalizeReferenceKey, type ClaimResult, type D1Like, type DuplicateIndex } from '../../../foundation/instapay-dedupe';
import { parseReceiptExtraction, type ParsedExtraction, type ReceiptExtract } from '../../../foundation/instapay-extract';
import { autoConfirmKey, firstPaymentCapMinor, isCleanPayment, nextAutoState, revertGraceUntil, revertKey, type AutoEvent, type AutoState } from '../../../foundation/instapay-state';
import { brandPack } from '../../brand';
import type { Env } from '../../env';
import { billingAudit, PLATFORM_WORKSPACE } from '../audit-reason';
import { announceSubscription } from './subscriptions';
import { alert } from '../observability';
import { isOffboarded } from '../ops/offboarded';
import { isStandaloneId } from '../workspace-kind';
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

/**
 * The daily pass: an operator switched auto-confirm to shadow or live but a binding or secret is missing, so every payment still needs a person
 * and nobody was told (prod 2026-11-17: /health said ready:false, the feature was silently off). Mode `off` is a decision, not a fault, so it stays quiet.
 */
export async function checkAutoReadiness(env: Env): Promise<void> {
  const mode = await getAutoMode(env);
  if (mode === 'off') return;
  const r = instapayAutoReady(env);
  if (!r.ready) alert('instapay_auto_not_ready', { mode, missing: r.missing });
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
    `UPDATE instapay_auto_confirmations SET state = ?, verdict = ?, reasons_json = ?, amount_minor = ?, expected_amount_minor = ?, is_first_payment = ?, extracted_json = coalesce(?, extracted_json), confirmed_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending_decision'`, // never wipe the reference stored before the claim (N3)
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

/**
 * INSTAPAY-CLEAN-1 + INSTAPAY-CAP-1. `first`: the workspace has no earlier confirmed InstaPay payment that is "clean" (human-confirmed, or auto-confirmed and listed in a
 * digest that was SENT). `uncleanAutoMinor`: what the system already auto-confirmed for this workspace and nobody has seen in a sent digest yet (not reverted). The
 * first-payment cap is CUMULATIVE over that window: unclean auto amounts + this payment <= one month of the plan, so several small payments in a row cannot add up past it.
 */
async function paymentHistory(env: Env, workspaceId: string, exceptId: string, now: number): Promise<{ first: boolean; uncleanAutoMinor: number }> {
  const { results } = await env.DB.prepare(
    `SELECT r.decided_by, r.decided_at, r.reverted_at, r.amount_minor, a.digest_sent_at FROM instapay_requests r LEFT JOIN instapay_auto_confirmations a ON a.request_id = r.id
      WHERE r.workspace_id = ? AND r.state = 'confirmed' AND r.id <> ?`,
  ).bind(workspaceId, exceptId).all<{ decided_by: string | null; decided_at: number | null; reverted_at: number | null; amount_minor: number; digest_sent_at: number | null }>();
  let first = true;
  let uncleanAutoMinor = 0;
  for (const p of results) {
    const auto = p.decided_by === SYSTEM_ACTOR;
    const clean = isCleanPayment({ confirmedBy: auto ? 'auto' : 'human', confirmedAt: p.decided_at ?? 0, digestSentAt: p.digest_sent_at, revertedAt: p.reverted_at }, now);
    if (clean) first = false;
    else if (auto && p.reverted_at === null) uncleanAutoMinor += p.amount_minor;
  }
  return { first, uncleanAutoMinor };
}

/**
 * N2: the auto path's confirm carries the cumulative first-payment cap IN the write (`?9` = one month of the plan, NULL when the workspace already has a clean payment):
 * D1 runs each statement atomically, so concurrent decisions of one workspace cannot all pass a sum read before any of them wrote. "Unclean" = confirmed by the system,
 * not reverted, and not listed in a digest sent after it (INSTAPAY-CLEAN-1).
 */
const UNCLEAN_AUTO_SUM_SQL = `(SELECT coalesce(sum(o.amount_minor), 0) FROM instapay_requests o LEFT JOIN instapay_auto_confirmations ac ON ac.request_id = o.id
  WHERE o.workspace_id = ?6 AND o.decided_by = 'system:auto-confirm' AND o.state = 'confirmed' AND o.reverted_at IS NULL AND o.id <> ?1
    AND (ac.digest_sent_at IS NULL OR ac.digest_sent_at < o.decided_at))`;
/** Built on first use, not at module load: `instapay.ts` and this file import each other, so CONFIRM_CLAIM_SQL is not defined yet while this module evaluates. */
export const autoConfirmClaimSql = (): string => `${CONFIRM_CLAIM_SQL} AND (?9 IS NULL OR ${UNCLEAN_AUTO_SUM_SQL} + ?7 <= ?9)`;
async function uncleanAutoSum(env: Env, workspaceId: string, exceptId: string): Promise<number> {
  return (await env.DB.prepare(`SELECT ${UNCLEAN_AUTO_SUM_SQL.replace(/\?6/g, '?2').replace(/\?1/g, '?1')} AS n`).bind(exceptId, workspaceId).first<{ n: number }>())?.n ?? 0;
}

type Expected = { amountMinor: number; capMonthlyMinor: number | null; reviewKind: boolean; priceDrift: boolean };
async function expectedFor(env: Env, r: InstapayRow, now: number): Promise<Expected> {
  if (r.kind === 'topup') return { amountMinor: r.amount_minor, capMonthlyMinor: await currentMonthlyPrice(env, r.workspace_id, now), reviewKind: false, priceDrift: false };
  const plan = await planPurchase(env, r.workspace_id, r.package_id ?? '', now);
  if (!plan.ok) return { amountMinor: r.amount_minor, capMonthlyMinor: null, reviewKind: true, priceDrift: false };
  // Only a purchase that STARTS a period is automatic. A renewal queued behind the running period, an upgrade or a queued switch changes someone's running plan: a person looks.
  const running = await env.DB.prepare("SELECT 1 FROM workspace_subscriptions WHERE workspace_id = ? AND package_id = ? AND period_end > ? AND status IN ('active', 'trialing')").bind(r.workspace_id, r.package_id, now).first();
  // The amount due is the ORDER's (what the merchant was told to pay and what the grant checks); a price that moved since the order was written waits for a person.
  return { amountMinor: r.amount_minor, capMonthlyMinor: await monthlyPriceOf(env, r.package_id ?? ''), reviewKind: plan.kind !== 'purchase' || !!running, priceDrift: plan.amountMinor !== r.amount_minor };
}

// ---- the decision ---------------------------------------------------------------------------------------------------------------------------------------------

const orderReasons = (xs: Iterable<ReasonCode>): ReasonCode[] => {
  const set = new Set(xs);
  return REASON_ORDER.filter((c) => set.has(c));
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
    const cur = await getRequestRow(env, r.id);
    if (cur?.state === 'confirmed' && cur.decided_by === SYSTEM_ACTOR) {
      // The system confirmed it, so the money decision stands: the row stays `pending_decision` (never `failed`) and the sweep finishes it as `auto_confirmed`
      // once the grant is done, so it reaches the digest and can be reverted (I3).
      alert('instapay_grant_failed', { severity: 'P1', id: r.id, workspace: r.workspace_id, error: errName(err) });
      return outcome((await autoByRequest(env, r.id))!);
    }
    // Anything unexpected before the money moved fails CLOSED: a person decides.
    await finalize(env, autoId, 'decide_human', { verdict: 'needs_human', reasons: ['EXTRACT_INCOMPLETE'] }, now);
    alert('instapay_auto_error', { id: r.id, workspace: r.workspace_id, error: errName(err) }); // info: the request is simply waiting for a person
    const row = (await autoByRequest(env, r.id))!;
    if (row.state === 'needs_human') await notifyWaiting(env, row, r).catch(() => undefined);
    return outcome(row);
  }
}

/**
 * A request the SYSTEM confirmed whose row is still `pending_decision` (the grant failed, or the isolate died after the confirm): grant it (idempotent) and end the row
 * `auto_confirmed` with the confirm time, so the digest lists it and "not received" works. An offboarded workspace (nothing can be granted) ends `failed`.
 */
async function completeActivation(env: Env, r: InstapayRow, autoId: string, now: number, base: Omit<Final, 'verdict' | 'reasons'> = {}): Promise<AutoOutcome> {
  try {
    await grant(env, r, now);
  } catch (err) {
    alert('instapay_grant_failed', { severity: 'P1', id: r.id, workspace: r.workspace_id, error: errName(err) });
    return outcome((await autoByRequest(env, r.id))!); // still pending: the daily repair + sweep try again
  }
  const after = await getRequestRow(env, r.id);
  if (after?.granted_at == null) {
    if (await isOffboarded(env, r.workspace_id)) await finalize(env, autoId, 'activation_failed', { ...base, verdict: 'not_granted', reasons: [] }, now); // credit_after_offboard (P1) was raised by the grant path
    return outcome((await autoByRequest(env, r.id))!);
  }
  await finalize(env, autoId, 'decide_auto', { amountMinor: r.amount_minor, expectedMinor: r.amount_minor, ...base, verdict: 'auto_confirm', reasons: [], confirmedAt: r.decided_at ?? now }, now);
  return outcome((await autoByRequest(env, r.id))!);
}

async function decide(env: Env, r: InstapayRow, autoId: string, now: number): Promise<AutoOutcome> {
  const done = async (event: 'decide_human' | 'decide_auto' | 'activation_failed', f: Final, notify: boolean): Promise<AutoOutcome> => {
    await finalize(env, autoId, event, f, now);
    const row = (await autoByRequest(env, r.id))!;
    if (notify && row.state === 'needs_human') await notifyWaiting(env, row, r).catch(() => undefined);
    return outcome(row);
  };
  // A take-over of a decision whose confirm already committed: finish the activation, never re-decide.
  if (r.state === 'confirmed' && r.decided_by === SYSTEM_ACTOR) return completeActivation(env, r, autoId, now);
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
  const history = await paymentHistory(env, r.workspace_id, r.id, now);
  const first = history.first;
  const obj = await env.MEDIA.get(r.proof_key);
  const bytes = obj ? await obj.arrayBuffer() : null;
  const parsed: ParsedExtraction = (bytes && r.proof_mime ? await readProofForAutoConfirm(env, bytes, r.proof_mime) : null) ?? parseReceiptExtraction(null);
  const extract: ReceiptExtract | null = parsed.extract;

  // The duplicate index is claimed BEFORE the decision. No index, an index that throws, or an unreadable reference = a duplicate (fail closed).
  // A claim is KEPT whatever happens next (a person may still confirm this request); only a rejection releases it (M7) and a revert burns it.
  const index = getDuplicateIndex(env);
  const refKey = extract ? normalizeReferenceKey(extract.reference) : null;
  let claim: ClaimResult | null = null;
  let duplicate: DecisionInput['duplicate'] = 'none';
  if (extract) {
    if (!index || !refKey || !r.proof_sha256) duplicate = 'both';
    else {
      try {
        // N3: the reference is written on the row BEFORE the claim, so a later reject or expiry can release it even if this decision dies before it finishes.
        await env.DB.prepare("UPDATE instapay_auto_confirmations SET extracted_json = ?, updated_at = ? WHERE id = ? AND state = 'pending_decision'").bind(JSON.stringify({ reference: extract.reference }), now, autoId).run();
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

  const input: DecisionInput = {
    extract,
    expected: { amountMinor: expected.amountMinor, payeeHandle: payeeHandle(env) ?? '' },
    now, mode, storeEnabled: wsOn, isFirstPayment: first,
    // INSTAPAY-CAP-1: the cap left after what was already auto-confirmed and not yet seen in a sent digest.
    // CHAT-SA-6: the FIRST InstaPay payment of a standalone workspace (no Store behind it, nobody vouching for it) is always a person's: cap 0 = FIRST_PAYMENT_OVER_CAP for any amount.
    firstPaymentCapMinor: isStandaloneId(r.workspace_id) && first ? 0 : Math.max(0, firstPaymentCapMinor({ monthlyPriceMinor: expected.capMonthlyMinor }) - history.uncleanAutoMinor),
    // The two-approver threshold ALWAYS wins (a threshold of 0 sends a kind a person must review straight to a person).
    dualControlThresholdMinor: expected.reviewKind ? 0 : adjustmentThreshold(env),
    duplicate,
    flags: parsed.flags,
  };
  const raw = decideInstapay(input);
  const reasons = orderReasons([...raw.reasons, ...(expected.priceDrift ? (['AMOUNT_MISMATCH'] as const) : [])]); // I4: a price that moved since the order
  const decision = { verdict: reasons.length === 0 ? raw.verdict : ('needs_human' as const), reasons };
  const mask = extract ? { amountMinor: extract.amountMinor, reference: extract.reference, transferredAt: extract.transferredAt, flags: parsed.flags } : { flags: parsed.flags };
  const base = { amountMinor: extract?.amountMinor, expectedMinor: expected.amountMinor, isFirst: first, extracted: mask };

  if (decision.verdict !== 'auto_confirm') {
    // The would-be verdict of a shadow decision is kept (so the rollout can compare it with what a person did).
    const would = mode === 'shadow' && orderReasons([...decideInstapay({ ...input, mode: 'live' }).reasons, ...(expected.priceDrift ? (['AMOUNT_MISMATCH'] as const) : [])]).length === 0 ? 'auto_confirm' : 'needs_human';
    return done('decide_human', { ...base, verdict: would, reasons: decision.reasons }, true);
  }

  // ---- live + every check passed: confirm, then grant ----
  const bankRef = normaliseBankRef(extract!.reference);
  if (!bankRef) {
    alert('instapay_auto_error', { id: r.id, workspace: r.workspace_id, where: 'bank_ref_invalid' }); // M9: a reference the bank_ref column cannot hold, not an amount problem
    return done('decide_human', { ...base, verdict: 'needs_human', reasons: ['EXTRACT_INCOMPLETE'] }, true);
  }
  if (!(await orderMatches(env, r))) {
    alert('instapay_amount_mismatch', { severity: 'P1', id: r.id, workspace: r.workspace_id });
    return done('decide_human', { ...base, verdict: 'needs_human', reasons: ['AMOUNT_MISMATCH'] }, true);
  }
  // The cap IN the confirm write (the safety layer) follows the same rule as the decision: 0 for a standalone workspace until a person has confirmed a payment (CHAT-SA-6).
  const backstopCap = isStandaloneId(r.workspace_id) ? 0 : firstPaymentCapMinor({ monthlyPriceMinor: expected.capMonthlyMinor });
  let claimed: D1Result | null = null;
  try {
    claimed = await env.DB.prepare(autoConfirmClaimSql()).bind(r.id, SYSTEM_ACTOR, now, bankRef, 0, r.workspace_id, r.amount_minor, now - NO_REF_WINDOW_MS, first ? backstopCap : null).run();
  } catch (err) {
    if (!/UNIQUE/i.test(errMsg(err))) throw err;
  }
  if (!claimed?.meta.changes) {
    // Lost the race (I2): look again. Confirmed by a person meanwhile = the claim stays (it now guards THAT confirmation; a revert would burn it). Rejected or expired =
    // the payment is gone, so the claim is released. Still under review (held, another reference) = a person decides, the claim stays.
    const cur = await getRequestRow(env, r.id);
    if (cur && (cur.state === 'rejected' || cur.state === 'expired')) await releaseClaimsOf(env, cur, extract!.reference);
    // N2: still under review and the cap no longer fits = another decision of this workspace confirmed first (the cap is checked IN the write): a person decides.
    const capLost = first && cur?.state === 'under_review' && (await uncleanAutoSum(env, r.workspace_id, r.id)) + r.amount_minor > backstopCap;
    return done('decide_human', { ...base, verdict: 'needs_human', reasons: [capLost ? 'FIRST_PAYMENT_OVER_CAP' : 'DUPLICATE_REFERENCE'] }, true);
  }
  await billingAudit(env, { at: now, actor: SYSTEM_ACTOR, action: 'instapay_auto_confirmed', workspaceId: r.workspace_id, ref: r.id, after: { id: r.id, kind: r.kind, amountMinor: r.amount_minor, isFirstPayment: first } });
  const confirmed = (await getRequestRow(env, r.id))!;
  return completeActivation(env, confirmed, autoId, now, base);
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
export async function sweepAutoConfirm(env: Env, now = Date.now()): Promise<{ decided: number; completed: number }> {
  // I3, whatever the mode: a request the SYSTEM confirmed whose row is still pending (a grant that failed, an isolate that died after the confirm) is finished first,
  // so it ends `auto_confirmed` (digest + revert) once granted. The money already moved; the switches only govern NEW decisions.
  const stuck = await env.DB.prepare(
    `SELECT a.request_id AS id FROM instapay_auto_confirmations a JOIN instapay_requests r ON r.id = a.request_id
      WHERE a.state = 'pending_decision' AND a.updated_at <= ? AND r.state = 'confirmed' AND r.decided_by = ? ORDER BY a.updated_at, a.id LIMIT 100`,
  ).bind(now - DECISION_LEASE_MS, SYSTEM_ACTOR).all<{ id: string }>();
  for (const x of stuck.results) await autoConfirmInstapay(env, x.id, now).catch((err) => alert('instapay_grant_failed', { severity: 'P1', id: x.id, error: errName(err) }));
  if ((await getAutoMode(env)) === 'off') return { decided: 0, completed: stuck.results.length };
  const { results } = await env.DB.prepare(
    `SELECT r.id FROM instapay_requests r LEFT JOIN instapay_auto_confirmations a ON a.request_id = r.id
      WHERE r.state = 'under_review' AND r.proof_key IS NOT NULL AND r.held_reason IS NULL AND r.proof_at <= ?1
        AND (a.id IS NULL OR (a.state = 'pending_decision' AND a.updated_at <= ?2)) ORDER BY r.proof_at, r.id LIMIT 100`,
  ).bind(now - SWEEP_AFTER_MS, now - DECISION_LEASE_MS).all<{ id: string }>();
  for (const x of results) await triggerAutoConfirm(env, x.id, now);
  return { decided: results.length, completed: stuck.results.length };
}

/**
 * M7: a request that is rejected or expired gives back what the shared duplicate index holds for it (only rows this payment owns and only while `held`; burned rows stay).
 * The keys are the reference the receipt was read as (or the confirmed bank reference) and the proof's hash. Never throws.
 */
export async function releaseClaimsOf(env: Env, r: InstapayRow, readReference?: string): Promise<void> {
  const index = getDuplicateIndex(env);
  if (!index || !r.proof_sha256) return;
  const row = await autoByRequest(env, r.id);
  let read: string | null = null;
  try { read = row?.extracted_json ? (JSON.parse(row.extracted_json) as { reference?: string }).reference ?? null : null; } catch { read = null; }
  const keys = new Set([readReference ?? null, read, r.bank_ref].map((k) => (k ? normalizeReferenceKey(k) : null)).filter((k): k is string => !!k));
  for (const referenceKey of keys) await index.release({ referenceKey, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id }).catch(() => undefined);
}

/**
 * I1 one-off backfill (idempotent, re-runnable): every CONFIRMED request's bank reference + proof hash is BURNED in the shared duplicate index, so a receipt confirmed
 * before the index existed (or by a person while it was unbound) can never be confirmed again in either product. One page of at most 200 per call; a reference with letters cannot
 * be a key and is counted as skipped (the bank_ref unique index still guards it). Burning a row another payment holds changes nothing (it is already blocked).
 */
export const BACKFILL_PAGE = 200;
export type BackfillResult = { ok: true; burned: number; skipped: number; next: string | null } | { ok: false; reason: 'reason_required' | 'not_ready' | 'bad_cursor' };
/** ONE bounded page per call (keyset on decided_at, id) so a call stays far under the Workers subrequest limit; call again with `next` until it is null (N3). */
export async function backfillDedupeHistory(env: Env, a: { actor: string; reason: string; after?: string | null; limit?: number }, now = Date.now()): Promise<BackfillResult> {
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  const index = getDuplicateIndex(env);
  if (!index) return { ok: false, reason: 'not_ready' };
  let after: [number, string] | null = null;
  if (a.after) {
    const m = /^(\d{1,16}):([\w-]{1,64})$/.exec(a.after);
    if (!m) return { ok: false, reason: 'bad_cursor' };
    after = [Number(m[1]), m[2]!];
  }
  const limit = Math.min(BACKFILL_PAGE, Math.max(1, Math.floor(a.limit ?? BACKFILL_PAGE)));
  const page = (await env.DB.prepare(
    `SELECT id, workspace_id, bank_ref, proof_sha256, decided_at FROM instapay_requests WHERE state = 'confirmed' ${after ? 'AND (coalesce(decided_at, 0) > ?1 OR (coalesce(decided_at, 0) = ?1 AND id > ?2))' : ''}
      ORDER BY coalesce(decided_at, 0), id LIMIT ${limit + 1}`,
  ).bind(...(after ?? [])).all<{ id: string; workspace_id: string; bank_ref: string | null; proof_sha256: string | null; decided_at: number | null }>()).results;
  const rows = page.slice(0, limit);
  let burned = 0, skipped = 0;
  for (const r of rows) {
    const key = r.bank_ref ? normalizeReferenceKey(r.bank_ref) : null;
    if (!key || !r.proof_sha256 || !/^[0-9a-f]{64}$/.test(r.proof_sha256)) { skipped++; continue; }
    await index.burn({ referenceKey: key, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id });
    burned++;
  }
  const last = rows[rows.length - 1];
  const next = page.length > limit && last ? `${last.decided_at ?? 0}:${last.id}` : null;
  await billingAudit(env, { at: now, actor: a.actor, action: 'instapay_dedupe_backfill', workspaceId: PLATFORM_WORKSPACE, after: { burned, skipped, more: next !== null }, reason });
  return { ok: true, burned, skipped, next };
}

/** An audit row written at most once per (action, request): a revert finished by a second call never writes it twice (M9). */
async function auditOnceFor(env: Env, a: Parameters<typeof billingAudit>[1] & { ref: string }): Promise<void> {
  if (await env.DB.prepare('SELECT 1 FROM billing_audit WHERE action = ? AND ref = ? LIMIT 1').bind(a.action, a.ref).first()) return;
  await billingAudit(env, a);
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
      const out = await stubOf(env, r.workspace_id).revertInstapayWallet({ creditedMinor: t.amount_minor, creditRef: `instapay:${r.reference}`, ref: `${revertKey('chat', r.id)}:wallet`, actor, note }, now);
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
  // Switched off once per revert: a second finishing call neither re-writes the switch nor re-audits it (M9). Already off (by the owner) = left as it is.
  if (await workspaceAutoEnabled(env, r.workspace_id)) await setWorkspaceAuto(env, { workspaceId: r.workspace_id, enabled: false, actor, reason: 'reverted payment' }, now);
  await auditOnceFor(env, { at: now, actor, action: 'instapay_auto_reverted', workspaceId: r.workspace_id, ref: r.id, after: { id: r.id, graceUntil: grace }, reason });
  await auditOnceFor(env, { at: now, actor, action: 'instapay_auto_reverted_credits', workspaceId: r.workspace_id, ref: r.id, after: { id: r.id, creditsRemovedMinor: removedMinor, creditsUsedMinor: usedMinor, aiCreditsRemoved: aiRemoved, aiCreditsUsed: aiUsed } });
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
