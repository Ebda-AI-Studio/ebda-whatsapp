import { Hono } from 'hono';
import { z } from 'zod';
import {
  fxPublish, instapayReject, operatorKillSwitch, instapayConfirm, instapayRelease, sharedNumberRegister, operatorAdjustmentCreate, operatorDecision, refundDashboardLink, operatorFundingSet, operatorSubscriptionSet, pricingOverridePublish, pricingSettingsPublish, rateCardPublish, trueupPublish,
} from '../core/api/contract';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import { sessionState } from '../core/identity/session';
import {
  changeLog, decideAdjustment, listAdjustments, listFx, listOverrides, listRateCards, listSettings, publishFx, publishOverride, publishRateCard, publishSettings, publishTrueup,
  requestAdjustment, setFunding,
} from '../core/billing/operator';
import { STORE_INCLUDED, setSubscription } from '../core/billing/subscriptions';
import { executeYearlyRefund, packageRefundQuote } from '../core/billing/package-orders';
import { currentSharedNumber, registerPlatformNumber, sharedEnabled } from '../core/shared/shared-number';
import { listSharedTemplates, submitSharedTemplate, syncSharedTemplates, type SharedTemplateFailure } from '../core/shared/shared-templates';
import { submitTemplateRequest } from './templates';
import { abandonRefundRequest, linkDashboardRefund, markCardRefundFailed, matchHeldRefund } from '../core/billing/card-refunds';
import { confirmInstapay, listForOperator, rejectInstapay, releaseInstapay, signProofLink, type DecideResult } from '../core/billing/instapay';
import { evictFromSharedNumber, opsStatus, pauseAllCampaigns, readmitToSharedNumber, restoreIntegrations, revokeIntegrations, suspendWorkspace, unsuspendWorkspace, type Result } from '../core/ops/kill-switch';
import { decideRefund, listRefundRequests, markManualPaid } from '../core/billing/refunds';

type E = { Bindings: Env; Variables: AuthVars };
/** /api/v1/operator/*, mounted behind requireSuperAdmin. Errors are {error, message?}. */
export const operatorRoutes = new Hono<E>();
// Every state-changing operator action re-checks that the session was not revoked, and fails closed (accounts binding missing or erroring = refused).
operatorRoutes.use('*', async (c, next) => {
  // Reads that return personal data (the InstaPay review list and proof images) re-check the session too; other reads keep working while the accounts service is down.
  const personal = c.req.path.includes('/instapay') || c.req.path.includes('/package-orders'); // the refund quote shows a merchant's wallet debt: re-check the session
  if ((c.req.method === 'GET' || c.req.method === 'HEAD') && !personal) return next();
  const s = await sessionState(c.env, c.get('principal').sessionId);
  if (s === 'revoked') return c.json({ error: 'forbidden', message: 'session_revoked' }, 403);
  if (s === 'unavailable') return c.json({ error: 'rate_limited', message: 'session_check_unavailable' }, 503);
  return next();
});
const actor = (c: { get(k: 'principal'): { userId: string } }) => c.get('principal').userId;
const bad = (c: { json(b: unknown, s: 400): Response }, message?: string) => c.json({ error: 'invalid_request', ...(message ? { message } : {}) }, 400);

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
  console.log(JSON.stringify({ audit: 'shared_template_submitted', actor: actor(c), name: b.data.name, language: b.data.language, category: b.data.category }));
  return c.json({ name: b.data.name, language: b.data.language, status: r.status }, 201);
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
  return r.ok ? c.json(r.trueup, 201) : c.json({ error: 'invalid_request', message: r.reason }, 409);
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
  if (!r.ok) return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason }, 409);
  console.log(JSON.stringify({ audit: 'operator_yearly_refund', orderId: r.orderId, shortenedMonths: r.shortenedMonths, debtSettledMinor: r.debtSettledMinor, cashRefundMinor: r.cashRefundMinor, actor: actor(c) }));
  const { ok: _ok, ...out } = r;
  return c.json(out);
});

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
  await c.env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, 'instapay_proof_viewed', ?, NULL, NULL, ?)").bind(Date.now(), actor(c), row.workspace_id, c.req.param('id')).run();
  return c.json(link);
});
const decided = (c: { json(b: unknown, s?: 200 | 403 | 404 | 409): Response }, r: DecideResult) => {
  if (r.ok) return c.json({ ...r.request, ...(r.needsSecond ? { needsSecond: true } : {}) });
  const status = r.reason === 'not_found' ? 404 : r.reason === 'self_approval_refused' ? 403 : 409;
  return c.json({ error: r.reason === 'not_found' ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request', message: r.reason }, status);
};
operatorRoutes.post('/instapay/:id/confirm', async (c) => {
  const b = instapayConfirm.safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return bad(c, 'bank_reference_invalid');
  return decided(c, await confirmInstapay(c.env, { id: c.req.param('id'), actor: actor(c), ...(b.data.bankRef ? { bankRef: b.data.bankRef } : {}) }));
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
const killSwitch = (run: (env: Env, a: { actor: string; workspaceId: string; reason: string }) => Promise<Result<object>>) =>
  async (c: import('hono').Context<E>) => {
    const b = operatorKillSwitch.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return bad(c, 'reason_required');
    const r = await run(c.env, { actor: actor(c), workspaceId: c.req.param('workspaceId')!, reason: b.data.reason });
    if (r.ok) return c.json(r.value);
    // The D1 half of a suspension is already active; only the workspace's own copy is pending. Saying so, and that the same call finishes it.
    if (r.reason === 'partial') return c.json({ error: 'unavailable', message: 'suspended_in_d1_workspace_copy_pending_retry' }, 503);
    return c.json({ error: 'not_found' }, 404);
  };
operatorRoutes.get('/workspaces/:workspaceId/ops', async (c) => {
  const st = await opsStatus(c.env, c.req.param('workspaceId'));
  return st ? c.json(st) : c.json({ error: 'not_found' }, 404);
});
operatorRoutes.post('/workspaces/:workspaceId/suspend', killSwitch(suspendWorkspace));
operatorRoutes.post('/workspaces/:workspaceId/unsuspend', killSwitch(unsuspendWorkspace));
operatorRoutes.post('/workspaces/:workspaceId/campaigns/pause', killSwitch(pauseAllCampaigns));
operatorRoutes.post('/workspaces/:workspaceId/shared-number/evict', killSwitch(evictFromSharedNumber));
operatorRoutes.post('/workspaces/:workspaceId/shared-number/readmit', killSwitch(readmitToSharedNumber));
operatorRoutes.post('/workspaces/:workspaceId/integrations/revoke', killSwitch(revokeIntegrations));
operatorRoutes.post('/workspaces/:workspaceId/integrations/restore', killSwitch(restoreIntegrations));
