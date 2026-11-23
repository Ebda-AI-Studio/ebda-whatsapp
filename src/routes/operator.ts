import { disconnectNumber } from '../core/numbers/numbers';
import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { z } from 'zod';
import {
  fxBackfill, fxBufferPin, fxPublish, instapayReject, operatorKillSwitch, operatorOffboardingRequest, sharedNumberRegister, operatorAdjustmentCreate, operatorDecision, refundDashboardLink, operatorFundingSet, operatorSubscriptionSet, pricingOverridePublish, pricingSettingsPublish, rateCardPublish, trueupPublish, auditLogQuery, exportContactQuery, instapayConfirm, instapayRelease,
} from '../core/api/contract';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import { sessionState } from '../core/identity/session';
import {
  changeLog, decideAdjustment, listAdjustments, listFx, listOverrides, listRateCards, listSettings, publishFx, publishOverride, publishRateCard, publishSettings, publishTrueup,
  requestAdjustment, setFunding,
} from '../core/billing/operator';
import { backfillFx, getFxBufferPin, setFxBufferPin } from '../core/billing/fx-daily';
import { STORE_INCLUDED, setSubscription } from '../core/billing/subscriptions';
import { executeYearlyRefund, packageRefundQuote } from '../core/billing/package-orders';
import { listPendingRequests, markRequestExecuted } from '../core/billing/yearly-refund-request';
import { currentSharedNumber, registerPlatformNumber, sharedEnabled } from '../core/shared/shared-number';
import { listAllRequests, markRequestsDone } from '../core/shared/shared-template-requests';
import { listSharedTemplates, submitSharedTemplate, syncSharedTemplates, type SharedTemplateFailure } from '../core/shared/shared-templates';
import { submitTemplateRequest } from './templates';
import { abandonRefundRequest, linkDashboardRefund, markCardRefundFailed, matchHeldRefund } from '../core/billing/card-refunds';
import { backfillDedupeHistory, listAutoConfirmations, revertAutoConfirmed, setAutoMode, setWorkspaceAuto, getAutoMode, instapayAutoReady } from '../core/billing/instapay-auto';
import { confirmInstapay, listForOperator, rejectInstapay, releaseInstapay, signProofLink, type DecideResult } from '../core/billing/instapay';
import { isReservedSuspendReason } from '../core/ops/suspension-mirror';
import { evictFromSharedNumber, opsStatus, pauseAllCampaigns, readmitToSharedNumber, restoreIntegrations, revokeIntegrations, suspendWorkspace, unsuspendWorkspace, type Result } from '../core/ops/kill-switch';
import { rotateTokenKey, rotationStatus } from '../core/enc-rotation';
import { eraseContactFlow } from '../core/contact-erase';
import { purgeAuditLog } from '../core/ops/audit-retention';
import { approveOffboarding, cancelOffboarding, getOffboardingWithLog, listOffboardings, releaseAbuseHold, requestOffboarding, runDueOffboardings } from '../core/ops/offboarding';
import { listAudit, recordAudit } from '../core/audit';
import { PLATFORM_WORKSPACE, reasonSql } from '../core/audit-reason';
import { subjectHash } from '../core/erasure';
import { waIdParam } from './contacts';
import { decideRefund, listRefundRequests, markManualPaid } from '../core/billing/refunds';
import { FLAG, readPlatformFlags, setPlatformFlag } from '../core/smart-layer/controls';
import { AGENT_MODEL_IDS, readAgentModelFlag, setAgentModelFlag } from '../core/ai/model-flag';
import { readAgentHealth } from '../core/ai/health';
import { DEFAULT_WORKERS_AI_MODEL } from '../core/ai/config';
import { isStandaloneId } from '../core/workspace-kind';
import { INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, listInvites, mintInvite, revokeInvite } from '../core/standalone/invites';

type E = { Bindings: Env; Variables: AuthVars };
/** /api/v1/operator/*, mounted behind requireSuperAdmin. Errors are {error, message?}. */
export const operatorRoutes = new Hono<E>();
/**
 * FAIL CLOSED: every operator request (GET included) re-checks that the session was not revoked, and an unreachable accounts service refuses it.
 * Only the reads named here skip the check; each is global price configuration with no personal data, so it keeps working while the accounts service is down.
 * A route added later is checked by default; `test/operator-session.test.ts` walks every registered route and fails if one differs from this list.
 */
export const OPERATOR_READS_WITHOUT_SESSION_CHECK: Readonly<Record<string, string>> = {
  'GET /operator/pricing-settings': 'platform price settings: global configuration, no personal data',
  'GET /operator/pricing-overrides/:workspaceId': 'a margin per workspace id: configuration, no personal data',
  'GET /operator/rate-cards': 'Meta rate cards: global configuration, no personal data',
  'GET /operator/fx-rates': 'exchange rates: global configuration, no personal data',
  'GET /operator/shared-templates': 'the platform number\'s template catalogue: no personal data',
};
operatorRoutes.use('*', async (c, next) => {
  const pattern = routePath(c, -1).replace(/^\/api\/v1/, '');
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && `GET ${pattern}` in OPERATOR_READS_WITHOUT_SESSION_CHECK) return next();
  const s = await sessionState(c.env, c.get('principal').sessionId);
  if (s === 'revoked') return c.json({ error: 'forbidden', message: 'session_revoked' }, 403);
  if (s === 'unavailable') return c.json({ error: 'rate_limited', message: 'session_check_unavailable' }, 503);
  return next();
});
const actor = (c: { get(k: 'principal'): { userId: string } }) => c.get('principal').userId;
const bad = (c: { json(b: unknown, s: 400): Response }, message?: string) => c.json({ error: 'invalid_request', ...(message ? { message } : {}) }, 400);

/** Who am I, store-independent: the web asks this when the token lists no store, to boot straight into the console. requireSuperAdmin already refused everyone else (403). */
operatorRoutes.get('/me', (c) => c.json({ superAdmin: true as const, userId: actor(c) }));

operatorRoutes.get('/pricing-settings', async (c) => c.json({ items: await listSettings(c.env) }));
operatorRoutes.post('/pricing-settings', async (c) => {
  const b = pricingSettingsPublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await publishSettings(c.env, { actor: actor(c), ...b.data });
  if (!r.ok && r.reason === 'vat_locked') return c.json({ error: 'vat_locked', message: 'VAT is 0 (Ruling VAT-0); a change needs a new ruling' }, 400);
  return r.ok ? c.json(r.value, 201) : c.json({ error: 'invalid_request', message: r.reason }, 400);
});

operatorRoutes.get('/pricing-overrides/:workspaceId', async (c) => c.json({ items: await listOverrides(c.env, c.req.param('workspaceId')) }));
operatorRoutes.post('/pricing-overrides/:workspaceId', async (c) => {
  const b = pricingOverridePublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(c.req.param('workspaceId')).first();
  if (!known) return c.json({ error: 'not_found' }, 404);
  const r = await publishOverride(c.env, { actor: actor(c), workspaceId: c.req.param('workspaceId'), ...b.data });
  return r.ok ? c.json(r.value, 201) : c.json({ error: 'invalid_request', message: r.reason }, 400);
});

operatorRoutes.get('/rate-cards', async (c) => c.json({ items: await listRateCards(c.env) }));
operatorRoutes.post('/rate-cards', async (c) => {
  const b = rateCardPublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await publishRateCard(c.env, { actor: actor(c), ...b.data });
  return r.ok ? c.json(r.value, 201) : c.json({ error: 'invalid_request', message: r.reason }, 400);
});

operatorRoutes.get('/fx-rates', async (c) => c.json({ items: await listFx(c.env) }));
operatorRoutes.post('/fx-rates', async (c) => {
  const b = fxPublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await publishFx(c.env, { actor: actor(c), ...b.data });
  return r.ok ? c.json(r.value, 201) : c.json({ error: 'invalid_request', message: r.reason }, 400);
});

operatorRoutes.post('/fx-backfill', async (c) => {
  const b = fxBackfill.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  return c.json(await backfillFx(c.env, { actor: actor(c), ...b.data }));
});
operatorRoutes.get('/fx-buffer-pin', async (c) => c.json(await getFxBufferPin(c.env)));
operatorRoutes.put('/fx-buffer-pin', async (c) => {
  const b = fxBufferPin.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  return c.json(await setFxBufferPin(c.env, { actor: actor(c), ...b.data }));
});

operatorRoutes.put('/numbers/:phoneNumberId/funding', async (c) => {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  // The brand-named value the plan used is accepted here, outside src/core, and stored under its neutral name.
  const b = operatorFundingSet.safeParse(raw && raw.funding === 'ebda_line' ? { ...raw, funding: 'platform_line' } : raw);
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await setFunding(c.env, { actor: actor(c), phoneNumberId: c.req.param('phoneNumberId'), funding: b.data.funding, reason: b.data.reason });
  return r === 'ok' ? c.json({ phoneNumberId: c.req.param('phoneNumberId'), funding: b.data.funding }) : c.json({ error: 'not_found' }, 404);
});

// Phase 8.2: the platform number. Funding (platform_line) is written in the same batch, never defaulted. Off = 404.
operatorRoutes.post('/shared-numbers', async (c) => {
  if (!sharedEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const b = sharedNumberRegister.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await registerPlatformNumber(c.env, { ...b.data, actor: actor(c) });
  return r === 'ok' ? c.json({ phoneNumberId: b.data.phoneNumberId, funding: 'platform_line' }, 201) : c.json({ error: 'number_conflict', message: 'number_belongs_to_a_workspace' }, 409);
});

// Item e: the platform WABA's templates (platform token only). Off, or no platform number registered = 404. Writes also passed the session re-check above.
const sharedTemplateFailure = (c: { json(b: unknown, s: 404 | 502 | 503 | 400): Response }, f: SharedTemplateFailure) =>
  f.reason === 'no_number' ? c.json({ error: 'not_found' }, 404)
    : f.reason === 'meta_rejected' ? c.json({ error: 'invalid_request', ...(f.message ? { message: f.message } : {}) }, 400)
      : c.json({ error: 'rate_limited', message: f.reason === 'token_unavailable' ? 'token_unavailable' : (f.message ?? 'meta_unavailable') }, 503);
operatorRoutes.get('/shared-templates', async (c) => {
  if (!sharedEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const number = await currentSharedNumber(c.env);
  return number ? c.json({ items: await listSharedTemplates(c.env, number) }) : c.json({ error: 'not_found' }, 404);
});
operatorRoutes.post('/shared-templates/sync', async (c) => {
  if (!sharedEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const r = await syncSharedTemplates(c.env);
  if (!r.ok) return sharedTemplateFailure(c, r);
  console.log(JSON.stringify({ audit: 'shared_templates_synced', actor: actor(c), upserted: r.upserted, removed: r.removed }));
  return c.json({ upserted: r.upserted, removed: r.removed });
});
operatorRoutes.post('/shared-templates', async (c) => {
  if (!sharedEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  // Marketing is refused here, not only at send time: a marketing template on the shared WABA could never be used (WA-SHARED-NOCAMP-1).
  const b = submitTemplateRequest.extend({ category: submitTemplateRequest.shape.category.exclude(['MARKETING']) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await submitSharedTemplate(c.env, b.data as Parameters<typeof submitSharedTemplate>[1]);
  if (!r.ok) return sharedTemplateFailure(c, r);
  await markRequestsDone(c.env, b.data.name, b.data.language); // a store asked for exactly this template: it is made
  console.log(JSON.stringify({ audit: 'shared_template_submitted', actor: actor(c), name: b.data.name, language: b.data.language, category: b.data.category }));
  return c.json({ name: b.data.name, language: b.data.language, status: r.status }, 201);
});

// What stores on the shared number asked the team to make (utility / authentication only). Shows the workspace id; no message content.
operatorRoutes.get('/shared-template-requests', async (c) => {
  if (!sharedEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const status = c.req.query('status');
  return c.json({ items: await listAllRequests(c.env, status === 'open' || status === 'done' || status === 'declined' ? status : undefined) });
});

operatorRoutes.get('/refund-requests', async (c) => c.json({ items: await listRefundRequests(c.env, { ...(c.req.query('state') ? { state: c.req.query('state')! } : {}) }) }));
operatorRoutes.post('/refund-requests/:id/decision', async (c) => {
  const b = operatorDecision.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c);
  const r = await decideRefund(c.env, { id: c.req.param('id'), decision: b.data.decision, actor: actor(c), ...(b.data.note ? { note: b.data.note } : {}) });
  if (r.ok) return c.json(r.request);
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});
operatorRoutes.post('/refund-requests/:id/link-dashboard-refund', async (c) => {
  const b = refundDashboardLink.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c);
  const r = await linkDashboardRefund(c.env, { requestId: c.req.param('id'), actor: actor(c), ...b.data });
  if (r.ok) return c.json({ ok: true, ...(r.adjustment ? { adjustment: r.adjustment } : {}) });
  if (r.reason === 'provider_unavailable') return c.json({ error: 'rate_limited', message: r.reason }, 503);
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});
operatorRoutes.post('/card-refunds/held/:refundId/match', async (c) => {
  const r = await matchHeldRefund(c.env, { refundId: c.req.param('refundId'), actor: actor(c) });
  if (r.ok) return c.json({ ok: true });
  if (r.reason === 'provider_unavailable') return c.json({ error: 'rate_limited', message: r.reason }, 503);
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});
operatorRoutes.post('/refund-requests/:id/card-refunds/:cardRefundId/mark-failed', async (c) => {
  const r = await markCardRefundFailed(c.env, { requestId: c.req.param('id'), cardRefundId: decodeURIComponent(c.req.param('cardRefundId')), actor: actor(c) });
  if (r.ok) return c.json({ ok: true });
  if (r.reason === 'provider_unavailable') return c.json({ error: 'rate_limited', message: r.reason }, 503);
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});
operatorRoutes.post('/refund-requests/:id/abandon', async (c) => {
  const r = await abandonRefundRequest(c.env, { id: c.req.param('id'), actor: actor(c) });
  if (r.ok) return c.json({ ok: true, ...(r.needsSecond ? { needsSecond: true } : {}), ...(r.already ? { already: true } : {}) });
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});
operatorRoutes.post('/refund-requests/:id/manual-paid', async (c) => ((await markManualPaid(c.env, c.req.param('id'), actor(c))) ? c.json({ ok: true }) : c.json({ error: 'invalid_request', message: 'not_manual_payout' }, 409)));

operatorRoutes.get('/adjustments', async (c) => c.json({ items: await listAdjustments(c.env, c.req.query('state') || undefined) }));
operatorRoutes.post('/workspaces/:workspaceId/adjustments', async (c) => {
  const b = operatorAdjustmentCreate.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await requestAdjustment(c.env, { actor: actor(c), workspaceId: c.req.param('workspaceId'), ...b.data });
  return r.ok ? c.json(r.adjustment, 201) : c.json({ error: 'not_found' }, 404);
});
operatorRoutes.post('/adjustments/:id/decision', async (c) => {
  const b = operatorDecision.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c);
  const r = await decideAdjustment(c.env, { actor: actor(c), id: c.req.param('id'), decision: b.data.decision });
  if (r.ok) return c.json(r.adjustment);
  if (r.reason === 'second_approver_required') return c.json({ error: 'forbidden', message: r.reason }, 403);
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : 'invalid_request', message: r.reason }, r.reason === 'not_found' ? 404 : 409);
});

operatorRoutes.post('/trueups', async (c) => {
  const b = trueupPublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c);
  const r = await publishTrueup(c.env, { actor: actor(c), ...b.data });
  return r.ok ? c.json(r.trueup, 201) : c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
});

operatorRoutes.get('/workspaces/:workspaceId/wallet', async (c) => {
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(c.req.param('workspaceId')).first();
  if (!known) return c.json({ error: 'not_found' }, 404);
  return c.json(await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(c.req.param('workspaceId'))).walletView());
});

// An operator assigns a package (a deal, a goodwill extension). The session was checked above (writes fail closed); the one writer pushes and tells the Store.
operatorRoutes.put('/workspaces/:workspaceId/subscription', async (c) => {
  const b = operatorSubscriptionSet.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const workspaceId = c.req.param('workspaceId');
  const [ws, pkg] = await Promise.all([
    c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(workspaceId).first(),
    c.env.DB.prepare('SELECT 1 FROM packages WHERE id = ?').bind(b.data.packageId).first(),
  ]);
  if (!ws || !pkg) return c.json({ error: 'not_found' }, 404);
  // WA-NOFREE-1: the free package belongs to the Store plan alone; an operator assigns a paid package (a deal or a goodwill extension of one).
  if (b.data.packageId === STORE_INCLUDED) return bad(c, 'store_included_is_store_plan_only');
  if (isStandaloneId(workspaceId!) && b.data.status === 'trialing') return bad(c, 'standalone_no_trial'); // CHAT-SA-6 (CHAT-ENABLE-1): a Chat-only workspace has no trial clock
  // An in-effect status needs a future end: the workspace would deny it anyway (WA-CANCEL-1), so refuse the contradiction instead of storing it.
  if ((b.data.status === 'active' || b.data.status === 'trialing') && b.data.periodEnd <= Date.now()) return bad(c, 'period_end_in_the_past');
  const r = await setSubscription(c.env, { workspaceId, packageId: b.data.packageId, status: b.data.status, periodStart: Date.now(), periodEnd: b.data.periodEnd, source: 'operator', ref: actor(c), reason: b.data.reason });
  console.log(JSON.stringify({ audit: 'operator_subscription_set', workspace: workspaceId, packageId: b.data.packageId, status: b.data.status, version: r.version, actor: actor(c) }));
  return c.json({ packageId: b.data.packageId, status: b.data.status, periodEnd: b.data.periodEnd, version: r.version, applied: r.applied });
});

// What a human can refund of a package order right now (Review Focus 5): unused whole months x floor(price / 12), the current month kept, wallet debt first.
operatorRoutes.get('/package-orders/:orderId/refund-quote', async (c) => {
  const q = await packageRefundQuote(c.env, c.req.param('orderId'));
  if (q === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (q === 'not_paid') return c.json({ error: 'invalid_request', message: 'order_not_paid' }, 409);
  if (typeof q === 'string') return c.json({ error: 'invalid_request', message: q }, 409); // queued_periods | order_queued: the same refusals the refund action makes
  return c.json(q);
});

// The operator's cancel + refund of a yearly period, debt first (the console action behind "your yearly plan runs until <date>; write to us at <support email>"). Idempotent.
operatorRoutes.post('/package-orders/:orderId/yearly-refund', async (c) => {
  const body = z.object({ reason: z.string().trim().min(5).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'reason_required');
  const r = await executeYearlyRefund(c.env, c.req.param('orderId'), { actor: actor(c), reason: body.data.reason });
  if (!r.ok) return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
  await markRequestExecuted(c.env, r.orderId, actor(c)); // a merchant's open request for this period is done (idempotent)
  console.log(JSON.stringify({ audit: 'operator_yearly_refund', orderId: r.orderId, shortenedMonths: r.shortenedMonths, debtSettledMinor: r.debtSettledMinor, cashRefundMinor: r.cashRefundMinor, actor: actor(c) }));
  const { ok: _ok, ...out } = r;
  return c.json(out);
});

// Merchants' yearly-refund requests waiting for a person (self-service A22): the console lists them, then runs the yearly refund above for the order.
operatorRoutes.get('/yearly-refund-requests', async (c) => c.json({ items: await listPendingRequests(c.env) }));

operatorRoutes.get('/change-log', async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const before = Number(c.req.query('before') ?? 0) || undefined;
  return c.json({ items: await changeLog(c.env, { limit, ...(before ? { before } : {}), ...(c.req.query('workspaceId') ? { workspaceId: c.req.query('workspaceId')! } : {}) }) });
});

// ---- InstaPay billing review (super admin; every write re-checks the session above) --------------------------------------------
operatorRoutes.get('/instapay', async (c) => c.json({ items: await listForOperator(c.env, c.req.query('state') || undefined) }));
operatorRoutes.get('/instapay/:id/proof-link', async (c) => {
  const row = await c.env.DB.prepare('SELECT workspace_id, proof_key FROM instapay_requests WHERE id = ?').bind(c.req.param('id')).first<{ workspace_id: string; proof_key: string | null }>();
  if (!row?.proof_key) return c.json({ error: 'not_found' }, 404);
  const link = await signProofLink(c.env, c.req.param('id'));
  if (!link) return c.json({ error: 'rate_limited', message: 'proof_links_unavailable' }, 503);
  await c.env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) VALUES (?, ?, 'instapay_proof_viewed', ?, NULL, NULL, ?)").bind(Date.now(), actor(c), row.workspace_id, c.req.param('id')).run();
  return c.json(link);
});
const decided = (c: { json(b: unknown, s?: 200 | 403 | 404 | 409): Response }, r: DecideResult) => {
  if (r.ok) return c.json({ ...r.request, ...(r.needsSecond ? { needsSecond: true } : {}) });
  const status = r.reason === 'not_found' ? 404 : r.reason === 'self_approval_refused' ? 403 : 409;
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request', message: r.reason }, status);
};
operatorRoutes.post('/instapay/:id/confirm', async (c) => {
  const b = instapayConfirm.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, b.error.issues[0]?.message === 'no_reference_needs_reason' ? 'reason_required' : 'bank_reference_invalid');
  return decided(c, await confirmInstapay(c.env, { id: c.req.param('id'), actor: actor(c), ...(b.data.bankRef ? { bankRef: b.data.bankRef } : {}), ...(b.data.noReference ? { noReference: { reason: b.data.reason! } } : {}) }));
});
// ---- InstaPay auto-confirm (super admin): verdicts, "not received", and the two kill switches. Each change needs a reason and is audited. ----
const autoReason = z.object({ reason: z.string().trim().min(5).max(300) });
operatorRoutes.get('/instapay/auto', async (c) => c.json({ mode: await getAutoMode(c.env), ready: instapayAutoReady(c.env), items: await listAutoConfirmations(c.env, c.req.query('state') || undefined) }));
operatorRoutes.post('/instapay/auto/:id/revert', async (c) => {
  const b = autoReason.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await revertAutoConfirmed(c.env, { id: c.req.param('id'), actor: actor(c), reason: b.data.reason });
  if (r.ok) return c.json(r);
  return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason }, 409);
});
operatorRoutes.post('/instapay/auto/backfill', async (c) => {
  const b = z.object({ reason: z.string().trim().min(5).max(300), after: z.string().max(100).nullable().optional() }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await backfillDedupeHistory(c.env, { actor: actor(c), reason: b.data.reason, after: b.data.after ?? null }); // one page per call: repeat with `next` until it is null
  return r.ok ? c.json(r) : r.reason === 'not_ready' ? c.json({ error: 'rate_limited', message: 'dedupe_index_not_bound' }, 503) : bad(c, r.reason);
});
operatorRoutes.put('/instapay/auto/mode', async (c) => {
  const b = z.object({ mode: z.enum(['off', 'shadow', 'live']), reason: z.string().trim().min(5).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'invalid_request');
  const r = await setAutoMode(c.env, { mode: b.data.mode, actor: actor(c), reason: b.data.reason });
  return r.ok ? c.json({ mode: b.data.mode }) : bad(c, r.reason);
});
operatorRoutes.put('/instapay/auto/workspaces/:workspaceId', async (c) => {
  const b = z.object({ enabled: z.boolean(), reason: z.string().trim().min(5).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'invalid_request');
  const r = await setWorkspaceAuto(c.env, { workspaceId: c.req.param('workspaceId'), enabled: b.data.enabled, actor: actor(c), reason: b.data.reason });
  return r.ok ? c.json({ workspaceId: c.req.param('workspaceId'), enabled: b.data.enabled }) : bad(c, r.reason);
});
operatorRoutes.post('/instapay/:id/release', async (c) => {
  const b = instapayRelease.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await releaseInstapay(c.env, { id: c.req.param('id'), actor: actor(c), reason: b.data.reason });
  if (r.ok) return c.json(r.request);
  const status = r.reason === 'not_found' ? 404 : r.reason === 'self_approval_refused' ? 403 : 409;
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request', message: r.reason }, status);
});
operatorRoutes.post('/instapay/:id/reject', async (c) => {
  const b = instapayReject.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  return decided(c, await rejectInstapay(c.env, { id: c.req.param('id'), actor: actor(c), reason: b.data.reason }));
});

// ---- W2-OPS: the kill switch. Every action needs a reason (5+ characters), is audited append-only with the actor, and fails closed on a revoked session (the guard above).
const killSwitch = (run: (env: Env, a: { actor: string; workspaceId: string; reason: string }) => Promise<Result<object>>, opts: { rejectReserved?: boolean } = {}) =>
  async (c: import('hono').Context<E>) => {
    const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return bad(c, 'reason_required');
    // A suspension reason is free text, but a value that names a derived hold would be treated as one by the mirror (cleared or overwritten): refused here, nothing written.
    if (opts.rejectReserved && isReservedSuspendReason(b.data.reason)) return bad(c, 'reserved_reason');
    const r = await run(c.env, { actor: actor(c), workspaceId: c.req.param('workspaceId')!, reason: b.data.reason });
    if (r.ok) return c.json(r.value);
    // The D1 half of a suspension is already active; only the workspace's own copy is pending. Saying so, and that the same call finishes it.
    if (r.reason === 'partial') return c.json({ error: 'unavailable', message: 'suspended_in_d1_workspace_copy_pending_retry' }, 503);
    return c.json({ error: 'not_found' }, 404);
  };
// ---- W2-OFFBOARD: workspace deletion. A reason is required and audited; `immediate` skips the 14-day cooling-off.
operatorRoutes.get('/offboardings', async (c) => c.json({ items: await listOffboardings(c.env, c.req.query('state') || undefined) }));
operatorRoutes.get('/workspaces/:workspaceId/offboarding', async (c) => {
  const st = await getOffboardingWithLog(c.env, c.req.param('workspaceId'));
  return st ? c.json(st) : c.json({ error: 'not_found' }, 404);
});
operatorRoutes.post('/workspaces/:workspaceId/offboarding', async (c) => {
  const b = operatorOffboardingRequest.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await requestOffboarding(c.env, { workspaceId: c.req.param('workspaceId')!, actor: actor(c), role: 'operator', ...b.data });
  if (r.ok) return c.json(r.value, 202);
  return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
});
operatorRoutes.delete('/workspaces/:workspaceId/offboarding', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await cancelOffboarding(c.env, { workspaceId: c.req.param('workspaceId')!, actor: actor(c), role: 'operator', reason: b.data.reason });
  if (r.ok) return c.json({ ok: true });
  return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
});
// OFFBOARD-2ND-APPROVER-1 and the abuse hold: a second operator approves an immediate deletion that writes off >= the InstaPay two-approval amount; an operator releases an abuse hold. Both need a reason.
operatorRoutes.post('/workspaces/:workspaceId/offboarding/approve', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await approveOffboarding(c.env, { workspaceId: c.req.param('workspaceId')!, actor: actor(c), reason: b.data.reason });
  if (r.ok) return c.json({ ok: true });
  if (r.reason === 'not_found') return c.json({ error: 'not_found' }, 404);
  return c.json({ error: r.reason === 'not_required' ? 'invalid_request' : 'forbidden', message: r.reason }, r.reason === 'not_required' ? 409 : 403);
});
operatorRoutes.post('/workspaces/:workspaceId/offboarding/release-hold', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  const r = await releaseAbuseHold(c.env, { workspaceId: c.req.param('workspaceId')!, actor: actor(c), reason: b.data.reason });
  if (r.ok) return c.json({ ok: true });
  if (r.reason === 'approver_cannot_release') return c.json({ error: 'forbidden', message: r.reason }, 403);
  return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason }, 409);
});
operatorRoutes.post('/offboardings/run', async (c) => c.json(await runDueOffboardings(c.env))); // finish an interrupted run now instead of waiting for the daily pass
// T8: the append-only audit log (who did what to which ids). Read-only.
// B5: a data-subject export on the subject's written request. The operator states why (kept in the audit record); the call is audited like the owner's.
operatorRoutes.get('/workspaces/:workspaceId/contacts/:waId/export', async (c) => {
  const workspaceId = c.req.param('workspaceId')!;
  const reason = z.string().trim().min(5).max(300).safeParse(c.req.query('reason'));
  const q = exportContactQuery.safeParse({ after: c.req.query('after') ?? undefined, limit: c.req.query('limit') ?? undefined });
  const waId = waIdParam(c.req.param('waId')!);
  if (!reason.success || !q.success || !waId) return bad(c, 'reason_required');
  if (!(await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(workspaceId).first())) return c.json({ error: 'not_found' }, 404);
  const out = await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).exportContact(waId, q.data.after, q.data.limit);
  if (!out) return c.json({ error: 'not_found' }, 404);
  await recordAudit(c.env, { workspaceId, actor: actor(c), role: 'operator', action: 'contact.export', targetType: 'waId', targetId: await subjectHash(c.env, workspaceId, waId), detail: { messages: out.messages.length, after: q.data.after }, reason: reason.data });
  c.header('cache-control', 'no-store');
  return c.json(out);
});

// AUDIT-RETENTION-1: rows past the retention are purged by ONE controlled batch (drop the append-only triggers, delete, audit the purge, re-create the triggers).
operatorRoutes.post('/audit-log/purge', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, 'reason_required');
  return c.json(await purgeAuditLog(c.env, { actor: actor(c), reason: b.data.reason }));
});

// STORE-ROUTES-OWNER-1: an operator erases a contact on the data subject's written request. The reason is required and kept (phone-free structure) in audit_reasons.
operatorRoutes.delete('/workspaces/:workspaceId/contacts/:waId', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  const waId = waIdParam(c.req.param('waId')!);
  if (!b.success || !waId) return bad(c, 'reason_required');
  const workspaceId = c.req.param('workspaceId')!;
  const r = await eraseContactFlow(c.env, { storeId: workspaceId, waIdParam: waId, actor: actor(c) });
  if (r.status === 200) await recordAudit(c.env, { workspaceId, actor: actor(c), role: 'operator', action: 'contact.erase', targetType: 'waId', targetId: await subjectHash(c.env, workspaceId, waId), reason: b.data.reason });
  return c.json(r.body, r.status);
});

// Final review I5: a person who connected a number removed the app (a P1 `meta_user_removed_app` and an owner notice); the OWNER or, here, an operator with a reason confirms any disconnect.
operatorRoutes.post('/workspaces/:workspaceId/numbers/:phoneNumberId/disconnect', async (c) => {
  const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
  const pn = c.req.param('phoneNumberId')!;
  if (!b.success || !/^[0-9]{1,30}$/.test(pn)) return bad(c, 'reason_required');
  const workspaceId = c.req.param('workspaceId')!;
  const r = await disconnectNumber(c.env, workspaceId, pn);
  await recordAudit(c.env, { workspaceId, actor: actor(c), role: 'operator', action: 'number.disconnect', targetType: 'phoneNumberId', targetId: pn, reason: b.data.reason, status: r.ok ? 200 : r.status });
  return r.ok ? c.json({ number: r.number, warnings: r.warnings }) : c.json({ error: r.error, message: r.message }, r.status);
});

operatorRoutes.get('/audit-log', async (c) => {
  const q = auditLogQuery.safeParse(c.req.query());
  if (!q.success) return bad(c, q.error.issues[0]?.message);
  return c.json({ items: await listAudit(c.env, q.data) });
});

// ---- Assistant rollout (Smart Layer): the platform switches live in D1 so they change without a deploy; a workspace's mode is its own Durable Object flag.
const assistantMode = z.enum(['off', 'answer-only', 'suggest', 'act']);
const assistantFlags = z.object({
  global: z.object({ kill: z.boolean().optional(), mode: assistantMode.optional(), shadow: z.boolean().optional() }).strict().optional(),
  product: z.object({ kill: z.boolean() }).strict().optional(),
  killedTools: z.array(z.string().min(1).max(64)).max(100).optional(),
}).strict();
operatorRoutes.get('/assistant', async (c) => c.json(await readPlatformFlags(c.env)));
const toolsList = (xs: string[]) => xs.join(',').slice(0, 500);
operatorRoutes.put('/assistant/flags', async (c) => {
  const b = assistantFlags.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const before = await readPlatformFlags(c.env);
  if (b.data.global) await setPlatformFlag(c.env, FLAG.global, b.data.global, actor(c));
  if (b.data.product) await setPlatformFlag(c.env, FLAG.product, b.data.product, actor(c));
  if (b.data.killedTools) await setPlatformFlag(c.env, FLAG.tools, b.data.killedTools, actor(c));
  const after = await readPlatformFlags(c.env);
  // The audit row (written by auditWrites) carries what changed: before -> after for each switch this call touched.
  c.set('auditDetail', {
    ...(b.data.global ? { globalKillFrom: before.global?.kill === true, globalKillTo: after.global?.kill === true, globalModeFrom: before.global?.mode ?? null, globalModeTo: after.global?.mode ?? null, shadowFrom: before.shadow === true, shadowTo: after.shadow === true } : {}),
    ...(b.data.product ? { chatKillFrom: before.product?.kill === true, chatKillTo: after.product?.kill === true } : {}),
    ...(b.data.killedTools ? { killedToolsFrom: toolsList(before.killedTools ?? []), killedToolsTo: toolsList(after.killedTools ?? []) } : {}),
  });
  return c.json(after);
});
// ---- Ruling WA-MODEL-FLAG-1: the Chat agent's platform model (two allowed ids; null = the current default). Super admin only (this whole router), a reason is required and audited. ----
operatorRoutes.get('/agent/model', async (c) => c.json({ model: await readAgentModelFlag(c.env), default: DEFAULT_WORKERS_AI_MODEL, allowed: AGENT_MODEL_IDS }));
// AGENT-HEALTH-1: the live hour and day counters behind the blocked-rate and cost-per-1k alerts (read-only; used for the 24 h watch after a model switch).
operatorRoutes.get('/agent/health', async (c) => c.json(await readAgentHealth(c.env)));
operatorRoutes.put('/agent/model', async (c) => {
  const b = z.object({ model: z.enum(AGENT_MODEL_IDS).nullable(), reason: z.string().trim().min(5).max(300) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues.some((i) => i.path[0] === 'reason') ? 'reason_required' : 'model_not_allowed');
  const r = await setAgentModelFlag(c.env, { model: b.data.model, actor: actor(c), reason: b.data.reason });
  return r.ok ? c.json({ model: r.model }) : bad(c, r.reason);
});
// The operator screen reads a workspace's current mode before changing it (an unknown workspace is a 404, never a default "off").
operatorRoutes.get('/workspaces/:workspaceId/assistant', async (c) => {
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(c.req.param('workspaceId')).first();
  if (!known) return c.json({ error: 'not_found' }, 404);
  const ws = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(c.req.param('workspaceId')));
  return c.json({ mode: await ws.assistantMode() });
});
operatorRoutes.put('/workspaces/:workspaceId/assistant', async (c) => {
  const b = z.object({ mode: assistantMode }).strict().safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(c.req.param('workspaceId')).first();
  if (!known) return c.json({ error: 'not_found' }, 404);
  const ws = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(c.req.param('workspaceId')));
  const from = await ws.assistantMode();
  await ws.setAssistantMode(b.data.mode);
  c.set('auditDetail', { modeFrom: from, modeTo: b.data.mode });
  return c.json({ mode: b.data.mode });
});

operatorRoutes.get('/workspaces/:workspaceId/ops', async (c) => {
  const st = await opsStatus(c.env, c.req.param('workspaceId'));
  return st ? c.json(st) : c.json({ error: 'not_found' }, 404);
});
operatorRoutes.post('/workspaces/:workspaceId/suspend', killSwitch(suspendWorkspace, { rejectReserved: true }));
operatorRoutes.post('/workspaces/:workspaceId/unsuspend', killSwitch(unsuspendWorkspace));
operatorRoutes.post('/workspaces/:workspaceId/campaigns/pause', killSwitch(pauseAllCampaigns));
operatorRoutes.post('/workspaces/:workspaceId/shared-number/evict', killSwitch(evictFromSharedNumber));
operatorRoutes.post('/workspaces/:workspaceId/shared-number/readmit', killSwitch(readmitToSharedNumber));
operatorRoutes.post('/workspaces/:workspaceId/integrations/revoke', killSwitch(revokeIntegrations));
operatorRoutes.post('/workspaces/:workspaceId/integrations/restore', killSwitch(restoreIntegrations));

// M-173: finishing a TOKEN_ENC_KEY rotation (docs/runbooks/token-enc-key-rotation.md). Counts only, never a value.
operatorRoutes.get('/token-key/status', async (c) => {
  const q = z.object({ cursor: z.string().max(200).optional(), budget: z.coerce.number().int().min(1).max(50_000).optional() }).safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return c.json({ error: 'invalid_request' }, 400);
  return c.json(await rotationStatus(c.env, { ...(q.data.cursor ? { cursor: q.data.cursor } : {}), ...(q.data.budget ? { budget: q.data.budget } : {}) }));
});
operatorRoutes.post('/token-key/rotate', async (c) => {
  const body = z.object({ batch: z.number().int().min(1).max(500).optional(), cursor: z.string().max(200).optional(), reason: z.string().trim().min(10).max(200) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const r = await rotateTokenKey(c.env, body.data.batch ?? 100, body.data.cursor ? { cursor: body.data.cursor } : {});
  await recordAudit(c.env, { workspaceId: PLATFORM_WORKSPACE, actor: actor(c), role: 'operator', action: 'token_key.rotate', reason: body.data.reason, status: r.ok ? 200 : 409 }); // the reason goes to audit_reasons (AUDIT-REASONS-1)
  console.log(JSON.stringify({ audit: 'token_key_rotate', by: c.get('principal').userId, ...(r.ok ? { rotated: r.rotated, remaining: r.remaining, unreadable: r.unreadable, complete: r.complete } : { refused: r.reason }) }));
  return r.ok ? c.json(r) : c.json({ error: 'invalid_request', message: r.reason }, 409);
});
// T35: the trail of operator "view as merchant" reads of one workspace, newest first (docs/support.md).
operatorRoutes.get('/view-log', async (c) => {
  const q = z.object({ workspaceId: z.string().min(1).max(64), limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return bad(c);
  const { results } = await c.env.DB.prepare(`SELECT v.at, v.actor, v.method, v.route, v.params, ${reasonSql('v', 'r')} AS reason FROM operator_view_log v LEFT JOIN audit_reasons r ON r.id = v.reason_id WHERE v.workspace_id = ? ORDER BY v.id DESC LIMIT ?`).bind(q.data.workspaceId, q.data.limit).all();
  return c.json({ items: results });
});
// B9: Meta data-deletion requests, newest first. State and counts only: the Meta user id is never stored, only a hash that is not shown here.
operatorRoutes.get('/meta-deletions', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT code, state, received_at AS receivedAt, removed_connections AS removedConnections, finished_at AS finishedAt FROM meta_deletion_requests ORDER BY received_at DESC LIMIT 50').all();
  return c.json({ items: results });
});

// ---- CHAT-SA-7: standalone workspaces (Chat without a Store). A LIST (suspend / unsuspend / offboard / view-as reuse the :workspaceId routes above) and the single-use invite codes.
const cursorOf = (at: number, id: string) => btoa(`${at}|${id}`);
function readCursor(raw: string | undefined): { at: number; id: string } | null | 'bad' {
  if (!raw) return null;
  try {
    const [at, ...rest] = atob(raw).split('|');
    const id = rest.join('|');
    return /^\d{1,15}$/.test(at ?? '') && id.length > 0 && id.length <= 64 ? { at: Number(at), id } : 'bad';
  } catch { return 'bad'; }
}
operatorRoutes.get('/workspaces', async (c) => {
  const kind = c.req.query('kind');
  if (kind !== undefined && kind !== 'store' && kind !== 'standalone') return bad(c, 'kind');
  const cur = readCursor(c.req.query('cursor'));
  if (cur === 'bad') return bad(c, 'cursor');
  const where = [kind ? 'w.kind = ?' : null, cur ? '(w.created_at < ? OR (w.created_at = ? AND w.id > ?))' : null].filter(Boolean).join(' AND ');
  const binds: (string | number)[] = [...(kind ? [kind] : []), ...(cur ? [cur.at, cur.at, cur.id] : [])];
  const { results } = await c.env.DB.prepare(
    `SELECT w.id AS id, w.name AS name, w.kind AS kind, w.country AS country, w.created_at AS created_at, w.suspended_at AS suspended_at, o.owner_user_id AS owner_user_id FROM workspaces w LEFT JOIN workspace_owners o ON o.workspace_id = w.id ${where ? `WHERE ${where}` : ''} ORDER BY w.created_at DESC, w.id LIMIT 51`,
  ).bind(...binds).all<{ id: string; name: string; kind: string; country: string; created_at: number; suspended_at: number | null; owner_user_id: string | null }>();
  const page = results.slice(0, 50);
  const last = page[page.length - 1];
  return c.json({
    items: page.map((r) => ({ id: r.id, name: r.name, kind: r.kind, country: r.country, createdAt: r.created_at, suspendedAt: r.suspended_at, ownerUserId: r.owner_user_id })),
    nextCursor: results.length > 50 && last ? cursorOf(last.created_at, last.id) : null,
  });
});
const inviteMint = z.object({ note: z.string().trim().max(200).optional(), days: z.number().int().min(1).max(INVITE_MAX_DAYS).default(INVITE_DEFAULT_DAYS) }).strict();
operatorRoutes.post('/standalone-invites', async (c) => {
  const b = inviteMint.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, b.error.issues[0]?.path.join('.') || 'body');
  const r = await mintInvite(c.env, { actor: actor(c), note: b.data.note || null, days: b.data.days });
  if (!r) return c.json({ error: 'unavailable', message: 'invite_unavailable' }, 503);
  await recordAudit(c.env, { workspaceId: PLATFORM_WORKSPACE, actor: actor(c), role: 'operator', action: 'invite.minted', targetType: 'invite', targetId: r.codeHash, detail: { days: b.data.days }, status: 201 });
  c.header('cache-control', 'no-store'); // the plain code is shown once; nothing may keep a copy
  return c.json({ code: r.code, codeHash: r.codeHash, expiresAt: r.expiresAt }, 201);
});
operatorRoutes.get('/standalone-invites', async (c) => c.json({ items: await listInvites(c.env) }));
operatorRoutes.post('/standalone-invites/:hash/revoke', async (c) => {
  const hash = c.req.param('hash')!;
  if (!/^[0-9a-f]{32}$/.test(hash)) return bad(c, 'hash');
  if (!(await revokeInvite(c.env, hash))) return c.json({ error: 'not_found' }, 404);
  await recordAudit(c.env, { workspaceId: PLATFORM_WORKSPACE, actor: actor(c), role: 'operator', action: 'invite.revoked', targetType: 'invite', targetId: hash, status: 200 });
  return c.json({ ok: true });
});
