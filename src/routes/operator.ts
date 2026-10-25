import { Hono } from 'hono';
import {
  fxPublish, operatorAdjustmentCreate, operatorDecision, operatorFundingSet, pricingOverridePublish, pricingSettingsPublish, rateCardPublish, trueupPublish,
} from '../core/api/contract';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import {
  changeLog, decideAdjustment, listAdjustments, listFx, listOverrides, listRateCards, listSettings, publishFx, publishOverride, publishRateCard, publishSettings, publishTrueup,
  requestAdjustment, setFunding,
} from '../core/billing/operator';
import { decideRefund, listRefundRequests, markManualPaid } from '../core/billing/refunds';

type E = { Bindings: Env; Variables: AuthVars };
/** /api/v1/operator/*, mounted behind requireSuperAdmin. Errors are {error, message?}. */
export const operatorRoutes = new Hono<E>();
const actor = (c: { get(k: 'principal'): { userId: string } }) => c.get('principal').userId;
const bad = (c: { json(b: unknown, s: 400): Response }, message?: string) => c.json({ error: 'invalid_request', ...(message ? { message } : {}) }, 400);

operatorRoutes.get('/pricing-settings', async (c) => c.json({ items: await listSettings(c.env) }));
operatorRoutes.post('/pricing-settings', async (c) => {
  const b = pricingSettingsPublish.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c, b.error.issues[0]?.message);
  const r = await publishSettings(c.env, { actor: actor(c), ...b.data });
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

operatorRoutes.get('/refund-requests', async (c) => c.json({ items: await listRefundRequests(c.env, { ...(c.req.query('state') ? { state: c.req.query('state')! } : {}) }) }));
operatorRoutes.post('/refund-requests/:id/decision', async (c) => {
  const b = operatorDecision.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return bad(c);
  const r = await decideRefund(c.env, { id: c.req.param('id'), decision: b.data.decision, actor: actor(c), ...(b.data.note ? { note: b.data.note } : {}) });
  if (r.ok) return c.json(r.request);
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

operatorRoutes.get('/change-log', async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const before = Number(c.req.query('before') ?? 0) || undefined;
  return c.json({ items: await changeLog(c.env, { limit, ...(before ? { before } : {}), ...(c.req.query('workspaceId') ? { workspaceId: c.req.query('workspaceId')! } : {}) }) });
});
