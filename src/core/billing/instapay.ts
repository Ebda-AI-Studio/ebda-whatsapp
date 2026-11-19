/**
 * InstaPay billing (behind INSTAPAY_BILLING_ENABLED): a merchant pays for a package or a wallet top-up by InstaPay transfer, uploads the
 * proof, and an operator confirms it.
 *
 * Money rules
 *  - The amount is computed on the server and stored: a package costs `packages.price_minor`, a top-up is the requested amount within the
 *    same min/max as a card top-up. The client never sends a price for a package and the body is strict.
 *  - The request writes its order in the SAME batch: a `package_orders` row (provider 'instapay') or a `topups` row (provider 'instapay',
 *    no card fee). Confirmation grants through the paths a card payment uses (`grantOrder` -> `setSubscription` + announce, or `credit` ->
 *    wallet post with the ledger outbox), keyed by the reference, so a double confirm, a retry or a repair grants exactly once.
 *  - Maker-checker: the person who made the request never confirms or rejects it; at or above ADJUSTMENT_APPROVAL_MINOR two DIFFERENT
 *    operators are needed (the first records `first_approver`, the second grants).
 *  - Every transition is ONE conditional UPDATE (`WHERE state = ...`), so confirm/reject/expire/upload racing each other end in one outcome.
 *  - The proof is stored privately in R2 under the workspace, checked by size and magic bytes, and is only ever read through a signed,
 *    short-lived link an operator asks for.
 */
import type { Env } from '../../env';
import { sessionState } from '../identity/session';
import { addBusinessMs, businessMsBetween } from './business-hours';
import type { InstapayPayee } from './instapay-payee';
import { adjustmentThreshold } from './operator';
import { ORDER_COLS, grantOrder, planPurchase, type PackageOrderRow, type PurchasePlan } from './package-orders';
import { MAX_TOPUP_MINOR, MIN_TOPUP_MINOR, TOPUP_COLS, credit, type TopupRow } from './topups';
import { tokenKeys } from '../enc-keys';
import { alert } from '../observability';
import { LAST_REASON_ID, REASON_PLACEHOLDER, billingAudit, reasonStmt } from '../audit-reason';
import { frozenForOffboarding } from '../ops/offboarded';
import { DRAIN_PAGE, drainKeyset, type PassOpts } from './drain';
import { getDuplicateIndex, releaseClaimsOf, triggerAutoConfirm } from './instapay-auto';
import { normalizeReferenceKey } from '../../../foundation/instapay-dedupe';

export type { InstapayPayee };
export const INSTAPAY_TTL_MS = 48 * 3_600_000;
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;
export const MAX_OPEN_PER_WORKSPACE = 5;
/** A proof that waits longer than this many business hours (Sun-Thu 09:00-17:00 Cairo) raises the overdue alert once. */
export const REVIEW_SLA_BUSINESS_MS = 4 * 3_600_000;
export const PROOF_LINK_TTL_MS = 2 * 60_000;
/** DUP-REF-REQUIRED-1: two no-reference confirms for one workspace and amount inside this window hold the second. */
export const NO_REF_WINDOW_MS = 7 * 86_400_000;

export const instapayEnabled = (env: Env): boolean => env.INSTAPAY_BILLING_ENABLED === 'true';
const stubOf = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));

export type RequestState = 'awaiting_proof' | 'under_review' | 'confirmed' | 'rejected' | 'expired';
type Row = {
  id: string; reference: string; workspace_id: string; kind: 'package' | 'topup'; package_id: string | null; amount_minor: number; currency: string; state: RequestState;
  created_by: string; created_at: number; expires_at: number; proof_key: string | null; proof_mime: string | null; proof_at: number | null;
  first_approver: string | null; decided_by: string | null; decided_at: number | null; reject_reason: string | null; granted_at: number | null;
  held_reason: 'duplicate_image' | 'duplicate_reference' | null; held_of: string | null; bank_ref: string | null;
  pending_bank_ref: string | null; proof_sha256: string | null; reverted_at: number | null; cancelled_at: number | null; contested_at: number | null; contest_note: string | null;
};
const COLS = 'id, reference, workspace_id, kind, package_id, amount_minor, currency, state, created_by, created_at, expires_at, proof_key, proof_mime, proof_at, first_approver, decided_by, decided_at, reject_reason, granted_at, held_reason, held_of, bank_ref, pending_bank_ref, proof_sha256, reverted_at, cancelled_at, contested_at, contest_note';
export type InstapayRequestDto = {
  id: string; reference: string; kind: 'package' | 'topup'; packageId: string | null; amountMinor: number; currency: string; state: RequestState;
  createdAt: number; expiresAt: number; hasProof: boolean; rejectReason: string | null; decidedAt: number | null;
  /** InstaPay auto-confirm: confirmed by the system / being checked now / reverted ("not received") with the end of its grace. */
  autoConfirmed: boolean; revertedAt: number | null; checking?: boolean; graceUntil?: number | null;
  /** Self-service: set when the owner withdrew the request before sending a proof / asked for a second look at the rejection. */
  cancelledAt: number | null; contestedAt: number | null;
};
export type OperatorInstapayDto = InstapayRequestDto & { workspaceId: string; createdBy: string; proofAt: number | null; firstApprover: string | null; decidedBy: string | null; proofMime: string | null; heldReason: Row['held_reason']; heldOf: string | null; bankRef: string | null; contestNote: string | null };
const dto = (r: Row): InstapayRequestDto => ({
  id: r.id, reference: r.reference, kind: r.kind, packageId: r.package_id, amountMinor: r.amount_minor, currency: r.currency, state: r.state, createdAt: r.created_at, expiresAt: r.expires_at,
  hasProof: r.proof_key !== null, rejectReason: r.reject_reason, decidedAt: r.decided_at,
  autoConfirmed: r.decided_by === 'system:auto-confirm', revertedAt: r.reverted_at, cancelledAt: r.cancelled_at, contestedAt: r.contested_at,
});
const opDto = (r: Row): OperatorInstapayDto => ({ ...dto(r), workspaceId: r.workspace_id, createdBy: r.created_by, proofAt: r.proof_at, firstApprover: r.first_approver, decidedBy: r.decided_by, proofMime: r.proof_mime, heldReason: r.held_reason, heldOf: r.held_of, bankRef: r.bank_ref, contestNote: r.contest_note });
/**
 * The ONE guarded claim that confirms a request (`?1` id, `?2` actor, `?3` now, `?4` bank reference, `?5` no-reference flag, `?6..?8` the no-reference twin window). The human path and the
 * auto-confirm path (instapay-auto.ts) both run it, so the two cannot drift: one conditional UPDATE, so confirm/reject/expire/upload racing each other end in one outcome.
 */
export const CONFIRM_CLAIM_SQL = "UPDATE instapay_requests SET state = 'confirmed', decided_by = ?2, decided_at = ?3, bank_ref = ?4, no_reference = ?5 WHERE id = ?1 AND state = 'under_review' AND held_reason IS NULL AND NOT EXISTS (SELECT 1 FROM instapay_releases WHERE request_id = ?1 AND actor = ?2) AND (?4 IS NULL OR NOT EXISTS (SELECT 1 FROM instapay_requests o WHERE o.bank_ref = ?4 AND o.id <> ?1)) AND (?5 = 0 OR NOT EXISTS (SELECT 1 FROM instapay_requests n WHERE n.no_reference = 1 AND n.state = 'confirmed' AND n.workspace_id = ?6 AND n.amount_minor = ?7 AND n.decided_at > ?8 AND n.id <> ?1))";

const get = (env: Env, id: string) => env.DB.prepare(`SELECT ${COLS} FROM instapay_requests WHERE id = ?`).bind(id).first<Row>();
export const getRequestRow = get;
export type InstapayRow = Row;

// ---- create ----------------------------------------------------------------------------------------------------------------------

/** A short code a person can copy or type from a phone: no 0/O/1/I. */
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReference(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return `WA-${[...b].map((x) => REF_ALPHABET[x % REF_ALPHABET.length]).join('')}`;
}

export type CreateInput = { kind: 'package'; packageId: string } | { kind: 'topup'; amountMinor: number };
export type CreateResult = { ok: true; request: InstapayRequestDto } | { ok: false; reason: 'disabled' | 'unavailable' | 'session_revoked' | 'invalid_amount' | 'unknown_package' | 'too_many_open' | 'yearly_queued' | 'offboarding' };

export async function createInstapayRequest(env: Env, a: { workspaceId: string; userId: string; sessionId: string; input: CreateInput; payee: InstapayPayee | null }, now = Date.now()): Promise<CreateResult> {
  if (await frozenForOffboarding(env, a.workspaceId)) return { ok: false, reason: 'offboarding' }; // OFFBOARD-FREEZE-1
  if (!instapayEnabled(env)) return { ok: false, reason: 'disabled' };
  if (!a.payee) return { ok: false, reason: 'unavailable' }; // without payee details the merchant would see an empty address: fail closed
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  let amount: number;
  let packageId: string | null = null;
  let plan: Extract<PurchasePlan, { ok: true }> | null = null;
  if (a.input.kind === 'package') {
    const p = await planPurchase(env, a.workspaceId, a.input.packageId, now); // the server's amount, kind and period length (WA-YEARLY-SWITCH-2)
    if (!p.ok) return p;
    plan = p;
    amount = p.amountMinor;
    packageId = a.input.packageId;
  } else {
    amount = a.input.amountMinor;
    if (!Number.isSafeInteger(amount) || amount < MIN_TOPUP_MINOR || amount > MAX_TOPUP_MINOR) return { ok: false, reason: 'invalid_amount' };
  }
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    const reference = newReference();
    // The cap is part of the insert (one statement): concurrent creates cannot all pass a count taken before any of them wrote. The order row
    // is written only if the request row exists, so a refused request leaves nothing behind.
    const req = env.DB.prepare(
      `INSERT INTO instapay_requests (id, reference, workspace_id, kind, package_id, amount_minor, currency, state, created_by, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'EGP', 'awaiting_proof', ?7, ?8, ?9
        WHERE (SELECT count(*) FROM instapay_requests WHERE workspace_id = ?3 AND state IN ('awaiting_proof', 'under_review')) < ${MAX_OPEN_PER_WORKSPACE}`,
    ).bind(id, reference, a.workspaceId, a.input.kind, packageId, amount, a.userId, now, now + INSTAPAY_TTL_MS);
    const order = a.input.kind === 'package'
      ? env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, currency, status, created_by, created_at, provider, kind, from_package, period_months, quoted_period_start, quoted_period_end) SELECT ?, ?, ?, ?, 'EGP', 'pending', ?, ?, 'instapay', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?)").bind(id, a.workspaceId, packageId, amount, a.userId, now, plan?.kind ?? 'purchase', plan?.fromPackage ?? null, plan?.periodMonths ?? 1, plan?.quotedStart ?? null, plan?.quotedEnd ?? null, id)
      : env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, provider) SELECT ?, ?, ?, 0, ?, 'EGP', 'pending', ?, ?, 'instapay' WHERE EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?)").bind(id, a.workspaceId, amount, amount, a.userId, now, id);
    try {
      const res = await env.DB.batch([req, order]); // both rows or neither
      if (!(res[0]?.meta.changes ?? 0)) return { ok: false, reason: 'too_many_open' };
      return { ok: true, request: dto((await get(env, id))!) };
    } catch (err) {
      if (!/UNIQUE/i.test(String(err instanceof Error ? err.message : err))) throw err; // a reference collision: draw another
    }
  }
  return { ok: false, reason: 'unavailable' };
}

export async function listForWorkspace(env: Env, workspaceId: string): Promise<InstapayRequestDto[]> {
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM instapay_requests WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 20`).bind(workspaceId).all<Row>();
  const autos = await env.DB.prepare("SELECT request_id, state, grace_until FROM instapay_auto_confirmations WHERE workspace_id = ? AND state IN ('pending_decision', 'reverted')").bind(workspaceId).all<{ request_id: string; state: string; grace_until: number | null }>();
  const by = new Map(autos.results.map((a) => [a.request_id, a]));
  return results.map((r) => { const a = by.get(r.id); return { ...dto(r), ...(a?.state === 'pending_decision' ? { checking: true } : {}), ...(a?.state === 'reverted' ? { graceUntil: a.grace_until } : {}) }; });
}
export async function listForOperator(env: Env, state?: string): Promise<OperatorInstapayDto[]> {
  const ok = state && ['awaiting_proof', 'under_review', 'confirmed', 'rejected', 'expired'].includes(state);
  const { results } = await env.DB.prepare(`SELECT ${COLS} FROM instapay_requests ${ok ? 'WHERE state = ?' : ''} ORDER BY created_at LIMIT 200`).bind(...(ok ? [state] : [])).all<Row>();
  return results.map(opDto);
}

// ---- the proof -------------------------------------------------------------------------------------------------------------------

type Detected = { mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf'; ext: string };
/** What the BYTES are, whatever the client claims. SVG, HTML and everything else is refused. */
export function detectProof(b: Uint8Array): Detected | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return { mime: 'image/webp', ext: 'webp' };
  if (b.length >= 5 && at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

export type ProofResult = { ok: true; request: InstapayRequestDto } | { ok: false; reason: 'not_found' | 'bad_state' | 'expired' | 'too_large' | 'bad_type' | 'empty' | 'session_revoked' | 'unavailable' };

/** `after` runs the auto-confirm attempt off the request (the route passes `ctx.waitUntil`); without it the attempt is awaited, so a test sees the outcome. */
export async function storeProof(env: Env, a: { workspaceId: string; requestId: string; sessionId: string; bytes: ArrayBuffer; contentType: string }, now = Date.now(), after?: (p: Promise<unknown>) => void): Promise<ProofResult> {
  if (!instapayEnabled(env)) return { ok: false, reason: 'unavailable' };
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  const r = await get(env, a.requestId);
  if (!r || r.workspace_id !== a.workspaceId) return { ok: false, reason: 'not_found' };
  if (r.state !== 'awaiting_proof') return { ok: false, reason: r.state === 'expired' ? 'expired' : 'bad_state' };
  if (now >= r.expires_at) return { ok: false, reason: 'expired' };
  if (a.bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  if (a.bytes.byteLength > MAX_PROOF_BYTES) return { ok: false, reason: 'too_large' };
  const kind = detectProof(new Uint8Array(a.bytes, 0, Math.min(16, a.bytes.byteLength)));
  if (!kind || a.contentType.split(';')[0]!.trim().toLowerCase() !== kind.mime) return { ok: false, reason: 'bad_type' };
  const key = `instapay-proof/${r.workspace_id}/${r.id}.${crypto.randomUUID()}.${kind.ext}`; // unique per upload: a losing double-submit deletes only ITS OWN object
  await env.MEDIA.put(key, a.bytes, { httpMetadata: { contentType: kind.mime } });
  // The state change is one conditional write: an expiry (or another upload) that got there first wins and the object is removed again.
  const sha = await sha256Hex(a.bytes);
  // The duplicate hold is computed INSIDE the same statement that moves the request to review: a failure after it cannot leave a duplicate unheld.
  const twin = "SELECT o.id FROM instapay_requests o WHERE o.proof_sha256 = ?1 AND o.id <> ?2 AND o.state IN ('under_review', 'confirmed')";
  const moved = await env.DB.prepare(
    `UPDATE instapay_requests SET state = 'under_review', proof_key = ?3, proof_mime = ?4, proof_bytes = ?5, proof_at = ?6, proof_sha256 = ?1,
       held_reason = CASE WHEN EXISTS (${twin}) THEN 'duplicate_image' ELSE NULL END,
       held_of = (${twin} ORDER BY o.proof_at, o.id LIMIT 1),
       held_at = CASE WHEN EXISTS (${twin}) THEN ?6 ELSE NULL END
     WHERE id = ?2 AND state = 'awaiting_proof' AND expires_at > ?6`,
  ).bind(sha, r.id, key, kind.mime, a.bytes.byteLength, now).run();
  if (!moved.meta.changes) {
    await env.MEDIA.delete(key).catch(() => undefined);
    const cur = await get(env, r.id);
    return { ok: false, reason: cur?.state === 'expired' || (cur && now >= cur.expires_at) ? 'expired' : 'bad_state' };
  }
  await announceDuplicate(env, r.id, sha, now);
  // The review deadline is a one-shot check at that moment (the daily pass stays as a backstop): 4 business hours after the proof arrived.
  await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(r.workspace_id)).scheduleInstapayOverdue(r.id, addBusinessMs(now, REVIEW_SLA_BUSINESS_MS))
    .catch((err: unknown) => alert('instapay_sla_not_scheduled', { id: r.id, error: err instanceof Error ? err.name : 'error' }));
  // InstaPay auto-confirm: the decision runs after the proof is safely stored; it never throws and never blocks the upload (a failure leaves the request with a person).
  const attempt = triggerAutoConfirm(env, r.id, now);
  if (after) after(attempt); else await attempt;
  return { ok: true, request: dto((await get(env, r.id))!) };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- duplicate proofs (C2) -------------------------------------------------------------------------------------------------------

/**
 * The same image on another request, in ANY workspace (or the same one twice), means one transfer is being used for two payments. The new request is held IN the upload statement
 * (see `storeProof`); this follow-up holds an earlier twin still under review too (nobody can tell which is honest; a confirmed earlier one is left alone), audits and alerts
 * (P1). If this follow-up fails, the new request is already held, and `confirmInstapay` re-checks twins before it claims, so nothing is confirmed unheld.
 */
async function announceDuplicate(env: Env, id: string, sha: string, now: number): Promise<void> {
  const mine = await get(env, id);
  if (mine?.held_reason !== 'duplicate_image') return;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_image', held_of = ?, held_at = ? WHERE proof_sha256 = ? AND id <> ? AND state = 'under_review' AND held_reason IS NULL").bind(id, now, sha, id), // whatever an earlier release cleared: THIS twin is new
    ]);
    await audit(env, { at: now, actor: 'system', action: 'instapay_held', workspaceId: mine.workspace_id, after: { id, reason: 'duplicate_image', of: mine.held_of } });
    alert('instapay_duplicate_proof', { severity: 'P1', workspace: mine.workspace_id, id, reason: 'duplicate_image' });
  } catch {
    alert('instapay_duplicate_proof', { severity: 'P1', workspace: mine.workspace_id, id, reason: 'duplicate_image', incomplete: true }); // the new request IS held; an earlier twin may not be yet
  }
}

/** The bank's reference as typed from the proof: no spaces or dashes, upper case, letters and digits only (4 to 40). Null = malformed. */
export function normaliseBankRef(raw: string): string | null {
  const t = raw.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{4,40}$/.test(t) ? t : null;
}

// ---- signed, short-lived proof links (operator only) ----------------------------------------------------------------------------

const enc = new TextEncoder();
/** The proof link has its own key, derived (HKDF-SHA-256, info "instapay-proof-link") from TOKEN_ENC_KEY: the raw key is never used to sign it. */
async function linkKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('instapay-proof-link') }, base, 256);
  return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
async function hmac(secret: string, text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', await linkKey(secret), enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function signProofLink(env: Env, id: string, now = Date.now()): Promise<{ url: string; expiresAt: number } | null> {
  if (!env.TOKEN_ENC_KEY) return null;
  const exp = now + PROOF_LINK_TTL_MS;
  return { url: `/api/v1/instapay-proof/${id}.${exp}.${await hmac(env.TOKEN_ENC_KEY, `${id}.${exp}`)}`, expiresAt: exp };
}
/** The proof for a valid, unexpired link; null for anything else (the caller answers 404, never saying why). */
/** The signature and time window of a proof link token, under the current TOKEN_ENC_KEY or (during a rotation, M-173) the previous one. */
export async function verifyProofLinkSignature(env: Env, token: string, now = Date.now()): Promise<boolean> {
  const m = /^([0-9a-f-]{36})\.(\d{10,15})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[2]);
  if (exp < now || exp > now + PROOF_LINK_TTL_MS + 60_000) return false;
  const got = enc.encode(m[3]!);
  for (const key of tokenKeys(env)) {
    const want = enc.encode(await hmac(key, `${m[1]}.${exp}`));
    if (want.byteLength === got.byteLength && crypto.subtle.timingSafeEqual(want, got)) return true;
  }
  return false;
}
export async function readProof(env: Env, token: string, now = Date.now()): Promise<{ body: ReadableStream; mime: string } | null> {
  if (!(await verifyProofLinkSignature(env, token, now))) return null;
  const m = /^([0-9a-f-]{36})\./.exec(token)!;
  const r = await get(env, m[1]!);
  if (!r?.proof_key || !r.proof_mime) return null;
  const obj = await env.MEDIA.get(r.proof_key);
  return obj ? { body: obj.body, mime: r.proof_mime } : null;
}

// ---- operator decisions ----------------------------------------------------------------------------------------------------------

async function audit(env: Env, a: { at: number; actor: string; action: string; workspaceId: string; after?: unknown; reason?: string }) {
  await billingAudit(env, a); // the reason goes to audit_reasons (AUDIT-REASONS-1)
}

export type DecideResult =
  | { ok: true; request: OperatorInstapayDto; needsSecond?: true }
  | { ok: false; reason: 'duplicate_check_unavailable' | 'not_found' | 'not_reviewable' | 'self_approval_refused' | 'second_approver_required' | 'amount_mismatch' | 'held' | 'duplicate_reference' | 'bad_reference' | 'releaser_cannot_approve' | 'bank_reference_required' | 'reference_mismatch' | 'reason_required' };

/** Grants what the request paid for, through the card payment's own paths. Idempotent: the reference decides, so a retry changes nothing. */
export async function grant(env: Env, r: Row, now: number): Promise<void> {
  if (r.reverted_at !== null) return; // a "not received" revert came first: nothing may be granted for this payment any more (the repair pass must not undo the revert)
  const ref = `instapay:${r.reference}`;
  if (r.kind === 'package') {
    const order = await env.DB.prepare(`SELECT ${ORDER_COLS} FROM package_orders WHERE order_id = ?`).bind(r.id).first<PackageOrderRow>();
    if (!order || order.package_id !== r.package_id || order.amount_minor !== r.amount_minor) throw new Error('instapay order does not match its request');
    await grantOrder(env, order, ref, now, { claim: true });
  } else {
    const t = await env.DB.prepare(`SELECT ${TOPUP_COLS} FROM topups WHERE order_id = ?`).bind(r.id).first<TopupRow>();
    if (!t || t.amount_minor !== r.amount_minor) throw new Error('instapay order does not match its request');
    const c = await credit(env, t, ref, now, ref);
    if (c === 'conflict') throw new Error('instapay top-up is bound to another transaction');
    if (c === 'offboarded') return; // credit_after_offboard (P1) was raised: granted_at stays empty and a person refunds the transfer
  }
  await env.DB.prepare('UPDATE instapay_requests SET granted_at = coalesce(granted_at, ?) WHERE id = ?').bind(now, r.id).run();
}

/** The order and the request must say the same amount before anything is granted (a tampered row fails closed). */
export async function orderMatches(env: Env, r: Row): Promise<boolean> {
  const o = r.kind === 'package'
    ? await env.DB.prepare('SELECT amount_minor FROM package_orders WHERE order_id = ?').bind(r.id).first<{ amount_minor: number }>()
    : await env.DB.prepare('SELECT amount_minor FROM topups WHERE order_id = ?').bind(r.id).first<{ amount_minor: number }>();
  return !!o && o.amount_minor === r.amount_minor;
}

export async function confirmInstapay(env: Env, a: { id: string; actor: string; bankRef?: string; noReference?: { reason: string } }, now = Date.now(), depth = 0): Promise<DecideResult> {
  if (depth > 2) return { ok: false, reason: 'not_reviewable' }; // looked again twice: something keeps changing under us
  const r = await get(env, a.id);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.state !== 'under_review') return { ok: false, reason: 'not_reviewable' };
  if (r.created_by === a.actor) return { ok: false, reason: 'self_approval_refused' };
  if (r.held_reason) return { ok: false, reason: 'held' }; // a duplicate: a person releases it first
  // Separation of duties: nobody who EVER released this request (not only the last releaser) may first-approve or confirm it.
  if (await everReleased(env, r.id, a.actor)) return { ok: false, reason: 'releaser_cannot_approve' };
  // Defence in depth: a twin that no release has reviewed and that is not held is held NOW (both requests), whatever was released before.
  const fresh = r.proof_sha256 ? await unreviewedTwin(env, r) : null;
  if (fresh) {
    await env.DB.batch([
      env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_image', held_of = ?, held_at = ? WHERE id = ? AND state = 'under_review' AND held_reason IS NULL").bind(fresh.id, now, r.id),
      env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_image', held_of = ?, held_at = ? WHERE id = ? AND state = 'under_review' AND held_reason IS NULL").bind(r.id, now, fresh.id),
    ]);
    await audit(env, { at: now, actor: 'system', action: 'instapay_held', workspaceId: r.workspace_id, after: { id: r.id, reason: 'duplicate_image', of: fresh.id } });
    alert('instapay_duplicate_proof', { severity: 'P1', workspace: r.workspace_id, id: r.id, reason: 'duplicate_image' });
    return { ok: false, reason: 'held' };
  }
  const needsTwo = r.amount_minor >= adjustmentThreshold(env);
  let ref: string | null = null;
  if (a.bankRef !== undefined) {
    ref = normaliseBankRef(a.bankRef);
    if (!ref) return { ok: false, reason: 'bad_reference' };
  }
  // DUP-REF-REQUIRED-1: the bank reference is required for EVERY amount. The one way round it is an audited `noReference` with a reason, never at a two-approval amount.
  const noRefReason = a.noReference ? a.noReference.reason.trim() : null;
  if (a.noReference) {
    if (ref) return { ok: false, reason: 'bad_reference' }; // a typed reference and "there is none" contradict each other
    if (needsTwo) return { ok: false, reason: 'bank_reference_required' };
    if (!noRefReason || noRefReason.length < 5) return { ok: false, reason: 'reason_required' };
  } else if (!ref) {
    return { ok: false, reason: 'bank_reference_required' };
  }
  if (noRefReason !== null) {
    // A second no-reference confirm for the same workspace and amount within 7 days: the re-encoded screenshot of one transfer. HOLD it, never confirm it unseen.
    const twin = await env.DB.prepare('SELECT id FROM instapay_requests WHERE no_reference = 1 AND state = \'confirmed\' AND workspace_id = ? AND amount_minor = ? AND decided_at > ? AND id <> ? ORDER BY decided_at LIMIT 1')
      .bind(r.workspace_id, r.amount_minor, now - NO_REF_WINDOW_MS, r.id).first<{ id: string }>();
    if (twin) return holdForReference(env, r, twin.id, now);
  }
  // A two-approval amount: the reference is REQUIRED at both approvals, the second must repeat the first's, and the duplicate check runs at both.
  if (needsTwo) {
    if (!ref) return { ok: false, reason: 'bank_reference_required' };
    if (r.first_approver !== null && r.pending_bank_ref !== ref) return { ok: false, reason: 'reference_mismatch' };
  }
  if (ref) {
    const other = await env.DB.prepare('SELECT id FROM instapay_requests WHERE (bank_ref = ?1 OR pending_bank_ref = ?1) AND id <> ?2 AND state NOT IN (\'rejected\', \'expired\') LIMIT 1').bind(ref, r.id).first<{ id: string }>();
    if (other) return holdForReference(env, r, other.id, now);
  }
  if (!(await orderMatches(env, r))) {
    alert('instapay_amount_mismatch', { severity: 'P1', id: r.id, workspace: r.workspace_id });
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (needsTwo) {
    if (r.first_approver === null) {
      const first = await env.DB.prepare("UPDATE instapay_requests SET first_approver = ?2, first_approved_at = ?3, pending_bank_ref = ?4 WHERE id = ?1 AND state = 'under_review' AND first_approver IS NULL AND held_reason IS NULL AND NOT EXISTS (SELECT 1 FROM instapay_releases WHERE request_id = ?1 AND actor = ?2) AND (?4 IS NULL OR NOT EXISTS (SELECT 1 FROM instapay_requests o WHERE (o.bank_ref = ?4 OR o.pending_bank_ref = ?4) AND o.id <> ?1 AND o.state NOT IN ('rejected', 'expired')))").bind(r.id, a.actor, now, ref).run();
      if (first.meta.changes) {
        await audit(env, { at: now, actor: a.actor, action: 'instapay_first_approval', workspaceId: r.workspace_id, after: { id: r.id, amountMinor: r.amount_minor } });
        return { ok: true, needsSecond: true, request: opDto((await get(env, r.id))!) };
      }
      if (ref) {
        // The reference was taken between our check and our write (the statement above carries the check too): hold, never fail.
        const other = await env.DB.prepare('SELECT id FROM instapay_requests WHERE (bank_ref = ?1 OR pending_bank_ref = ?1) AND id <> ?2 AND state NOT IN (\'rejected\', \'expired\') LIMIT 1').bind(ref, r.id).first<{ id: string }>();
        if (other) return holdForReference(env, r, other.id, now);
      }
      return confirmInstapay(env, a, now, depth + 1); // someone recorded the first approval, or a hold / release landed, between our read and write: look again
    }
    if (r.first_approver === a.actor) return { ok: false, reason: 'second_approver_required' };
  }
  // I1: a person's confirmation claims the platform-global duplicate index too (shared with the Store), so a receipt a person confirmed here can never be confirmed
  // again in either product. A receipt the index already holds for another payment is HELD (a person compares the transfers), never confirmed. The bank reference is
  // the key when it is all digits (InstaPay references are); a reference with letters cannot be a key and is guarded by the bank_ref unique index alone. No index
  // bound = today's behaviour (the per-product checks above); an index that fails = refuse (a person retries), never confirm unchecked.
  const refKey = ref ? normalizeReferenceKey(ref) : null;
  const index = getDuplicateIndex(env);
  if (index && refKey && r.proof_sha256) {
    let hit: string;
    try {
      hit = await index.claim({ referenceKey: refKey, imageSha256: r.proof_sha256, product: 'chat', ownerId: r.workspace_id, paymentId: r.id });
    } catch {
      return { ok: false, reason: 'duplicate_check_unavailable' };
    }
    if (hit === 'duplicate_reference' || hit === 'duplicate_image') return holdForReference(env, r, 'dedupe-index', now);
  }
  let claim: D1Result;
  try {
    claim = await env.DB.prepare(CONFIRM_CLAIM_SQL).bind(r.id, a.actor, now, ref, noRefReason !== null ? 1 : 0, r.workspace_id, r.amount_minor, now - NO_REF_WINDOW_MS).run();
  } catch (err) {
    // The unique index on bank_ref: another request took this reference between our check and our write.
    if (ref && /UNIQUE/i.test(String(err instanceof Error ? err.message : err))) {
      const other = await env.DB.prepare('SELECT id FROM instapay_requests WHERE bank_ref = ?').bind(ref).first<{ id: string }>();
      return holdForReference(env, r, other?.id ?? 'unknown', now);
    }
    throw err;
  }
  if (!claim.meta.changes) {
    if (noRefReason !== null) {
      // The claim carries the no-reference twin check itself (two concurrent confirms cannot both pass a SELECT made before either wrote): hold, never fail.
      const twin = await env.DB.prepare('SELECT id FROM instapay_requests WHERE no_reference = 1 AND state = \'confirmed\' AND workspace_id = ? AND amount_minor = ? AND decided_at > ? AND id <> ? ORDER BY decided_at LIMIT 1').bind(r.workspace_id, r.amount_minor, now - NO_REF_WINDOW_MS, r.id).first<{ id: string }>();
      if (twin) return holdForReference(env, r, twin.id, now);
    }
    if (ref) {
      const other = await env.DB.prepare('SELECT id FROM instapay_requests WHERE bank_ref = ? AND id <> ?').bind(ref, r.id).first<{ id: string }>();
      if (other) return holdForReference(env, r, other.id, now); // the UPDATE itself found the reference taken: held + alert, no constraint error
    }
    if (await everReleased(env, r.id, a.actor)) return { ok: false, reason: 'releaser_cannot_approve' };
    return { ok: false, reason: (await get(env, r.id))?.held_reason ? 'held' : 'not_reviewable' };
  }
  await audit(env, { at: now, actor: a.actor, action: 'instapay_confirmed', workspaceId: r.workspace_id, after: { id: r.id, kind: r.kind, amountMinor: r.amount_minor, ...(noRefReason !== null ? { noReference: true } : {}) }, ...(noRefReason !== null ? { reason: noRefReason } : {}) });
  if (noRefReason !== null) alert('instapay_no_reference', { workspace: r.workspace_id, id: r.id, amountMinor: r.amount_minor });
  try {
    await grant(env, (await get(env, r.id))!, now);
  } catch (err) {
    // The request is confirmed but the grant did not finish: the daily repair finishes it (and the grant is idempotent). Say so loudly.
    alert('instapay_grant_failed', { severity: 'P1', id: r.id, workspace: r.workspace_id, error: err instanceof Error ? err.name : 'error' });
  }
  return { ok: true, request: opDto((await get(env, r.id))!) };
}

async function everReleased(env: Env, id: string, actor: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM instapay_releases WHERE request_id = ? AND actor = ? LIMIT 1').bind(id, actor).first());
}
/** A request with the same image that no release of THIS request reviewed (a release clears only the pair it looked at). */
async function unreviewedTwin(env: Env, r: Row): Promise<{ id: string } | null> {
  return env.DB.prepare("SELECT o.id FROM instapay_requests o WHERE o.proof_sha256 = ?1 AND o.id <> ?2 AND o.state IN ('under_review', 'confirmed') AND o.id NOT IN (SELECT twin_of FROM instapay_releases WHERE request_id = ?2 AND twin_of IS NOT NULL) ORDER BY o.proof_at, o.id LIMIT 1")
    .bind(r.proof_sha256, r.id).first<{ id: string }>();
}

async function holdForReference(env: Env, r: Row, of: string, now: number): Promise<DecideResult> {
  await env.DB.prepare("UPDATE instapay_requests SET held_reason = 'duplicate_reference', held_of = ?, held_at = ? WHERE id = ? AND state = 'under_review' AND held_reason IS NULL").bind(of, now, r.id).run();
  await audit(env, { at: now, actor: 'system', action: 'instapay_held', workspaceId: r.workspace_id, after: { id: r.id, reason: 'duplicate_reference', of } });
  alert('instapay_duplicate_proof', { severity: 'P1', workspace: r.workspace_id, id: r.id, reason: 'duplicate_reference' });
  return { ok: false, reason: 'duplicate_reference' };
}

export type ReleaseResult = { ok: true; request: OperatorInstapayDto } | { ok: false; reason: 'not_found' | 'not_reviewable' | 'not_held' | 'self_approval_refused' | 'reason_required' | 'approver_cannot_release' };

/** A person looked at both transfers in the bank app and says this one is genuine: the hold is lifted (audited with the reason). It can then be confirmed like any other. */
export async function releaseInstapay(env: Env, a: { id: string; actor: string; reason: string }, now = Date.now()): Promise<ReleaseResult> {
  const reason = a.reason.trim();
  if (reason.length < 5) return { ok: false, reason: 'reason_required' };
  const r = await get(env, a.id);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.state !== 'under_review') return { ok: false, reason: 'not_reviewable' };
  if (r.created_by === a.actor) return { ok: false, reason: 'self_approval_refused' };
  if (!r.held_reason) return { ok: false, reason: 'not_held' };
  if (r.first_approver === a.actor) return { ok: false, reason: 'approver_cannot_release' }; // whoever approved it cannot also clear its hold
  // The release row and the lifted hold are ONE batch; the row names the pair it reviewed (`twin_of`), so a later, different twin holds again.
  const [, rel, res] = await env.DB.batch([
    reasonStmt(env, { at: now, workspaceId: r.workspace_id, actor: a.actor, action: 'instapay.release', reason }),
    env.DB.prepare(`INSERT INTO instapay_releases (request_id, actor, reason, reason_id, held_reason, twin_of, at) SELECT ?1, ?2, ?3, ${LAST_REASON_ID}, held_reason, held_of, ?4 FROM instapay_requests WHERE id = ?1 AND state = 'under_review' AND held_reason IS NOT NULL AND coalesce(first_approver, '') <> ?2`).bind(r.id, a.actor, REASON_PLACEHOLDER, now),
    env.DB.prepare("UPDATE instapay_requests SET held_reason = NULL, held_of = NULL, held_at = NULL WHERE id = ?1 AND state = 'under_review' AND held_reason IS NOT NULL AND coalesce(first_approver, '') <> ?2").bind(r.id, a.actor),
  ]);
  if (!rel!.meta.changes || !res!.meta.changes) return { ok: false, reason: 'not_held' };
  await audit(env, { at: now, actor: a.actor, action: 'instapay_released', workspaceId: r.workspace_id, after: { id: r.id, was: r.held_reason, of: r.held_of }, reason });
  return { ok: true, request: opDto((await get(env, r.id))!) };
}

export async function rejectInstapay(env: Env, a: { id: string; actor: string; reason: string }, now = Date.now()): Promise<DecideResult> {
  const r = await get(env, a.id);
  if (!r) return { ok: false, reason: 'not_found' };
  if (r.state !== 'under_review') return { ok: false, reason: 'not_reviewable' };
  if (r.created_by === a.actor) return { ok: false, reason: 'self_approval_refused' };
  const claim = await env.DB.prepare("UPDATE instapay_requests SET state = 'rejected', decided_by = ?, decided_at = ?, reject_reason = ?, pending_bank_ref = NULL WHERE id = ? AND state = 'under_review'").bind(a.actor, now, a.reason, r.id).run();
  if (!claim.meta.changes) return { ok: false, reason: 'not_reviewable' };
  // The order closes with it: a rejected payment never grants anything.
  await env.DB.batch([
    env.DB.prepare("UPDATE package_orders SET status = 'failed' WHERE order_id = ? AND provider = 'instapay' AND status = 'pending'").bind(r.id),
    env.DB.prepare("UPDATE topups SET state = 'failed' WHERE order_id = ? AND provider = 'instapay' AND state = 'pending'").bind(r.id),
  ]);
  await audit(env, { at: now, actor: a.actor, action: 'instapay_rejected', workspaceId: r.workspace_id, after: { id: r.id, kind: r.kind, amountMinor: r.amount_minor }, reason: a.reason });
  await releaseClaimsOf(env, r); // M7: a rejected payment no longer holds its receipt in the shared duplicate index (a burned one stays burned)
  return { ok: true, request: opDto((await get(env, r.id))!) };
}

// ---- the merchant's own decisions (self-service) -----------------------------------------------------------------------------------
// The merchant may change the STATE of their own request, never decide the money: neither function confirms, grants or credits anything. Both are ONE conditional
// UPDATE keyed by id AND workspace (another store's id matches nothing), and the order rows follow in the same D1 batch only when that claim won.

/** How long after a rejection the owner may still ask for a second look (inside the 180 days the proof is kept). */
export const CONTEST_WINDOW_MS = 30 * 86_400_000;
export const CONTEST_NOTE_MAX = 500;

export type SelfDecision = { ok: true; request: InstapayRequestDto } | { ok: false; reason: 'not_found' | 'bad_state' | 'session_revoked' | 'unavailable' | 'offboarding' | 'already_contested' | 'too_many_open' | 'not_contestable' };

async function selfGuard(env: Env, a: { workspaceId: string; requestId: string; sessionId: string }): Promise<{ ok: true; r: Row } | { ok: false; reason: 'not_found' | 'session_revoked' | 'unavailable' }> {
  if (!instapayEnabled(env)) return { ok: false, reason: 'unavailable' };
  const session = await sessionState(env, a.sessionId);
  if (session === 'revoked') return { ok: false, reason: 'session_revoked' };
  if (session === 'unavailable') return { ok: false, reason: 'unavailable' };
  const r = await get(env, a.requestId);
  if (!r || r.workspace_id !== a.workspaceId) return { ok: false, reason: 'not_found' }; // another store's request looks exactly like a missing one
  return { ok: true, r };
}

/**
 * Withdraw a request that has NO proof yet (`awaiting_proof`): no transfer has been shown to us, so nothing can be owed. A request with a proof is a person's to decide
 * (the money may already have moved) and is refused as `bad_state`. State becomes 'expired' with `cancelled_at` set; the order closes with it.
 */
export async function cancelInstapay(env: Env, a: { workspaceId: string; requestId: string; sessionId: string; userId: string }, now = Date.now()): Promise<SelfDecision> {
  const g = await selfGuard(env, a);
  if (!g.ok) return g;
  const res = await env.DB.batch([
    env.DB.prepare("UPDATE instapay_requests SET state = 'expired', cancelled_at = ?3, pending_bank_ref = NULL WHERE id = ?1 AND workspace_id = ?2 AND state = 'awaiting_proof'").bind(a.requestId, a.workspaceId, now),
    env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE order_id = ?1 AND workspace_id = ?2 AND provider = 'instapay' AND status = 'pending' AND EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?1 AND state = 'expired' AND cancelled_at = ?3)").bind(a.requestId, a.workspaceId, now),
    env.DB.prepare("UPDATE topups SET state = 'expired' WHERE order_id = ?1 AND workspace_id = ?2 AND provider = 'instapay' AND state = 'pending' AND EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?1 AND state = 'expired' AND cancelled_at = ?3)").bind(a.requestId, a.workspaceId, now),
  ]);
  if (res[0]!.meta.changes !== 1) return { ok: false, reason: 'bad_state' }; // exactly one row or nothing: raced with a proof upload / expiry / another cancel
  await audit(env, { at: now, actor: a.userId, action: 'instapay_cancelled_by_owner', workspaceId: a.workspaceId, after: { id: a.requestId, kind: g.r.kind, amountMinor: g.r.amount_minor } });
  return { ok: true, request: dto((await get(env, a.requestId))!) };
}

/**
 * Ask for a second look at a rejection, ONCE, within 30 days, while the proof is still kept. The request goes back to `under_review` for a PERSON (maker-checker and the
 * duplicate checks are unchanged; the auto-confirm path is not triggered); it never confirms anything. Refused for a system decision, a second contest, a request with no
 * proof, a full queue (the same cap as creating one) and a workspace that is being offboarded.
 */
export async function contestInstapay(env: Env, a: { workspaceId: string; requestId: string; sessionId: string; userId: string; note: string }, now = Date.now()): Promise<SelfDecision> {
  const g = await selfGuard(env, a);
  if (!g.ok) return g;
  if (await frozenForOffboarding(env, a.workspaceId)) return { ok: false, reason: 'offboarding' }; // OFFBOARD-FREEZE-1
  const r = g.r;
  if (r.state !== 'rejected') return { ok: false, reason: 'bad_state' };
  if (r.contested_at !== null) return { ok: false, reason: 'already_contested' };
  if (r.decided_by === 'system:auto-confirm' || r.proof_key === null || r.decided_at === null || now - r.decided_at > CONTEST_WINDOW_MS) return { ok: false, reason: 'not_contestable' };
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE instapay_requests SET state = 'under_review', contested_at = ?3, contest_note = ?4, decided_by = NULL, decided_at = NULL, first_approver = NULL, first_approved_at = NULL, notice_seen_at = ?3
       WHERE id = ?1 AND workspace_id = ?2 AND state = 'rejected' AND contested_at IS NULL AND proof_key IS NOT NULL AND decided_by IS NOT 'system:auto-confirm' AND decided_at > ?5
         AND (SELECT count(*) FROM instapay_requests WHERE workspace_id = ?2 AND state IN ('awaiting_proof', 'under_review')) < ${MAX_OPEN_PER_WORKSPACE}`,
    ).bind(a.requestId, a.workspaceId, now, a.note, now - CONTEST_WINDOW_MS),
    // The order the rejection closed opens again with it, in the same transaction and only if the claim above won.
    env.DB.prepare("UPDATE package_orders SET status = 'pending' WHERE order_id = ?1 AND workspace_id = ?2 AND provider = 'instapay' AND status = 'failed' AND EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?1 AND state = 'under_review' AND contested_at = ?3)").bind(a.requestId, a.workspaceId, now),
    env.DB.prepare("UPDATE topups SET state = 'pending' WHERE order_id = ?1 AND workspace_id = ?2 AND provider = 'instapay' AND state = 'failed' AND EXISTS (SELECT 1 FROM instapay_requests WHERE id = ?1 AND state = 'under_review' AND contested_at = ?3)").bind(a.requestId, a.workspaceId, now),
  ]);
  if (res[0]!.meta.changes !== 1) {
    const cur = await get(env, a.requestId);
    const open = (await env.DB.prepare("SELECT count(*) AS n FROM instapay_requests WHERE workspace_id = ? AND state IN ('awaiting_proof', 'under_review')").bind(a.workspaceId).first<{ n: number }>())?.n ?? 0;
    if (cur?.state === 'rejected' && cur.contested_at === null && open >= MAX_OPEN_PER_WORKSPACE) return { ok: false, reason: 'too_many_open' };
    return { ok: false, reason: cur?.contested_at ? 'already_contested' : 'bad_state' };
  }
  await audit(env, { at: now, actor: a.userId, action: 'instapay_contested_by_owner', workspaceId: a.workspaceId, after: { id: a.requestId, kind: r.kind, amountMinor: r.amount_minor }, reason: a.note });
  // The same review clock as a fresh proof: 4 business hours, then the overdue alert (a failure to schedule is alerted, never silent).
  await stubOf(env, a.workspaceId).scheduleInstapayOverdue(a.requestId, addBusinessMs(now, REVIEW_SLA_BUSINESS_MS))
    .catch((err: unknown) => alert('instapay_sla_not_scheduled', { id: a.requestId, error: err instanceof Error ? err.name : 'error' }));
  return { ok: true, request: dto((await get(env, a.requestId))!) };
}

// ---- daily passes ----------------------------------------------------------------------------------------------------------------

/** 48 h without a proof: the request and its order expire. A request with a proof waits for a person and is never expired by the clock. */
export async function expireInstapay(env: Env, now = Date.now()): Promise<{ expired: number }> {
  const res = await env.DB.prepare(`UPDATE instapay_requests SET state = 'expired', pending_bank_ref = NULL WHERE state = 'awaiting_proof' AND expires_at <= ? RETURNING ${COLS}`).bind(now).all<Row>();
  // M7: an expired request gives back whatever the shared duplicate index holds for it (same rule as a rejection; a proof-less request normally holds nothing).
  for (const r of res.results) if (r.proof_sha256) await releaseClaimsOf(env, r);
  if (res.results.length) {
    await env.DB.batch([
      env.DB.prepare("UPDATE package_orders SET status = 'expired' WHERE provider = 'instapay' AND status = 'pending' AND order_id IN (SELECT id FROM instapay_requests WHERE state = 'expired')"),
      env.DB.prepare("UPDATE topups SET state = 'expired' WHERE provider = 'instapay' AND state = 'pending' AND order_id IN (SELECT id FROM instapay_requests WHERE state = 'expired')"),
    ]);
  }
  return { expired: res.results.length };
}

/** A confirmed request whose grant never finished (a crash between the claim and the grant) is completed now, once, and reported. Drains every page (M-178). */
export async function repairInstapay(env: Env, now = Date.now(), opts: PassOpts = {}): Promise<{ granted: number }> {
  const size = opts.page ?? DRAIN_PAGE;
  let granted = 0;
  await drainKeyset<Row, [number, string]>({
    name: 'repair_instapay', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT ${COLS} FROM instapay_requests WHERE state = 'confirmed' AND granted_at IS NULL ${after ? 'AND (coalesce(decided_at, 0) > ?1 OR (coalesce(decided_at, 0) = ?1 AND id > ?2))' : ''} ORDER BY coalesce(decided_at, 0), id LIMIT ${size}`)
      .bind(...(after ?? [])).all<Row>()).results,
    cursorOf: (r) => [r.decided_at ?? 0, r.id],
    handle: async (r) => {
      try {
        await grant(env, r, now);
        granted++;
        if (await markOnce(env, 'instapay_confirmed_not_granted', r)) alert('instapay_confirmed_not_granted', { severity: 'P1', id: r.id, workspace: r.workspace_id });
      } catch (err) {
        if (await markOnce(env, 'instapay_repair_failed', r)) alert('instapay_repair_failed', { severity: 'P1', id: r.id, error: err instanceof Error ? err.name : 'error' }); // once per request, not every daily pass
      }
    },
  });
  return { granted };
}
async function markOnce(env: Env, action: string, r: Row): Promise<boolean> {
  const x = await env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) SELECT ?, ?, ?, ?, NULL, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM billing_audit WHERE action = ? AND ref = ?)')
    .bind(Date.now(), 'system', action, r.workspace_id, r.id, action, r.id).run();
  return x.meta.changes > 0;
}

/** One request's overdue check (the scheduled deadline, and the daily backstop): alerts `instapay_proof_overdue` once if it is still under review past 4 business hours. */
export async function overdueOne(env: Env, id: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare("SELECT id, workspace_id, kind, amount_minor, proof_at FROM instapay_requests WHERE id = ? AND state = 'under_review' AND proof_at IS NOT NULL AND overdue_alerted_at IS NULL")
    .bind(id).first<{ id: string; workspace_id: string; kind: string; amount_minor: number; proof_at: number }>();
  if (!r) return false;
  const waited = businessMsBetween(r.proof_at, now);
  if (waited <= REVIEW_SLA_BUSINESS_MS) return false;
  const claim = await env.DB.prepare("UPDATE instapay_requests SET overdue_alerted_at = ? WHERE id = ? AND overdue_alerted_at IS NULL AND state = 'under_review'").bind(now, r.id).run();
  if (!claim.meta.changes) return false;
  alert('instapay_proof_overdue', { severity: 'P1', id: r.id, workspace: r.workspace_id, kind: r.kind, amountMinor: r.amount_minor, waitedBusinessMinutes: Math.round(waited / 60_000) });
  return true;
}

/** Proofs waiting longer than 4 business hours alert once each (`instapay_proof_overdue`, severity P1): the daily backstop for the scheduled checks. Drains every page. */
export async function overdueInstapay(env: Env, now = Date.now(), opts: PassOpts = {}): Promise<{ alerted: number }> {
  const size = opts.page ?? DRAIN_PAGE;
  let alerted = 0;
  await drainKeyset<{ id: string; proof_at: number }, [number, string]>({
    name: 'overdue_instapay', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT id, proof_at FROM instapay_requests WHERE state = 'under_review' AND proof_at IS NOT NULL AND overdue_alerted_at IS NULL ${after ? 'AND (proof_at > ?1 OR (proof_at = ?1 AND id > ?2))' : ''} ORDER BY proof_at, id LIMIT ${size}`)
      .bind(...(after ?? [])).all<{ id: string; proof_at: number }>()).results,
    cursorOf: (r) => [r.proof_at, r.id],
    handle: async (r) => { if (await overdueOne(env, r.id, now)) alerted++; },
  });
  return { alerted };
}

/** The newest rejection the owner has not opened yet, for the inbox notice. In-app only: no approved utility template exists for it. */
export async function rejectionNotice(env: Env, workspaceId: string, now = Date.now()): Promise<{ id: string; reason: string } | null> {
  const r = await env.DB.prepare("SELECT id, reject_reason FROM instapay_requests WHERE workspace_id = ? AND state = 'rejected' AND notice_seen_at IS NULL AND decided_at > ? ORDER BY decided_at DESC LIMIT 1")
    .bind(workspaceId, now - 14 * 86_400_000).first<{ id: string; reject_reason: string | null }>();
  return r ? { id: r.id, reason: r.reject_reason ?? '' } : null;
}
export async function markRejectionsSeen(env: Env, workspaceId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE instapay_requests SET notice_seen_at = ? WHERE workspace_id = ? AND state = 'rejected' AND notice_seen_at IS NULL").bind(now, workspaceId).run();
}

// ---- proof lifecycle (M-096) -----------------------------------------------------------------------------------------------------

/** A proof image is kept 180 days after the decision (the longest realistic bank-dispute window), then deleted; the hash stays so a re-used transfer is still caught. */
export const PROOF_RETENTION_MS = 180 * 86_400_000;

/** Daily: deletes the proof of every request decided more than 180 days ago, page by page. An undecided request keeps its proof whatever its age. A refused R2 delete keeps the reference (retried tomorrow) and alerts. */
export async function purgeInstapayProofs(env: Env, now = Date.now(), opts: PassOpts = {}): Promise<{ deleted: number; failed: number }> {
  const size = opts.page ?? DRAIN_PAGE;
  const out = { deleted: 0, failed: 0 };
  await drainKeyset<{ id: string; proof_key: string; decided_at: number }, [number, string]>({
    name: 'purge_instapay_proofs', pageSize: size, ...(opts.maxBatches ? { maxBatches: opts.maxBatches } : {}),
    page: async (after) => (await env.DB.prepare(`SELECT id, proof_key, decided_at FROM instapay_requests WHERE proof_key IS NOT NULL AND decided_at IS NOT NULL AND decided_at < ?1 ${after ? 'AND (decided_at > ?2 OR (decided_at = ?2 AND id > ?3))' : ''} ORDER BY decided_at, id LIMIT ${size}`)
      .bind(now - PROOF_RETENTION_MS, ...(after ?? [])).all<{ id: string; proof_key: string; decided_at: number }>()).results,
    cursorOf: (r) => [r.decided_at, r.id],
    handle: async (r) => {
      try {
        await env.MEDIA.delete(r.proof_key);
        await env.DB.prepare('UPDATE instapay_requests SET proof_key = NULL, proof_mime = NULL WHERE id = ? AND proof_key = ?').bind(r.id, r.proof_key).run();
        out.deleted++;
      } catch (err) {
        out.failed++;
        alert('instapay_proof_purge_failed', { severity: 'P1', id: r.id, error: err instanceof Error ? err.name : 'error' });
      }
    },
  });
  return out;
}
