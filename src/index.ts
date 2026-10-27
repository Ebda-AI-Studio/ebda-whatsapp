import * as Sentry from '@sentry/cloudflare';
import { env as workerEnv } from 'cloudflare:workers';
import { Hono } from 'hono';
import { brandPack } from './brand';
import type { Env } from './env';
import { selectVerifier } from './identity-select';
import { configureAgent } from './core/ai/config';
import { signupEnabled } from './core/numbers/numbers';
import { verifyMetaSignature } from './core/meta/signature';
import { extractAccountEvents, extractCoexistence, extractEvents, extractQualityEvents, extractNameUpdates, extractTemplateCategoryUpdates, extractTemplateStatuses, extractTierUpdates } from './core/meta/webhook-schema';
import { numberForDisplayPhone, workspaceForPhoneNumber, workspacesForWaba } from './core/routing';
import { mark } from './core/timing';
import { alert, bindAlerts, captureError, errClass, scrubEvent } from './core/observability';
import { consumeSendBatch, consumeSendDlq, type SendJob } from './core/send-queue';
import { requireStoreAccess, requireSuperAdmin, type AuthVars } from './core/identity/middleware';
import { operatorRoutes } from './routes/operator';
import type { IdentityVerifier } from './core/identity/verifier';
import { normaliseE164 } from './core/phone';
import { TIER_LIMITS } from './core/throttle';
import { buyerKey } from './core/buyer-key';
import { messagesRoutes } from './routes/messages';
import { conversationsRoutes } from './routes/conversations';
import { mediaRoutes } from './routes/media';
import { realtimeRoutes } from './routes/ws';
import { templatesRoutes } from './routes/templates';
import { configureStoreLink } from './core/store-link';
import { consumeStoreEvents } from './core/store-events';
import { sendOtp, type OtpResult } from './core/otp';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { bridgeFor } from './core/store-link';
import { ordersRoutes } from './routes/orders';
import { proofRoutes } from './routes/proof';
import { agentRoutes } from './routes/agent';
import { connectorRoutes } from './routes/connectors';
import { contactsRoutes } from './routes/contacts';
import { importsRoutes } from './routes/imports';
import { segmentsRoutes } from './routes/segments';
import { campaignsRoutes } from './routes/campaigns';
import { trackRoutes } from './routes/track';
import { numbersRoutes } from './routes/numbers';
import { reconcileEntitlements } from './core/billing/subscriptions';
import { repairPackageOrders } from './core/billing/package-orders';
import { reconcileCardRefunds, sweepAbandonedRefunds } from './core/billing/card-refunds';
import { expireInstapay, overdueInstapay, repairInstapay } from './core/billing/instapay';
import { paymentProvider } from './core/billing/payments';
import { handleProviderWebhook, reconfirmUnconfirmed, repairTopups } from './core/billing/topups';
import { packageRoutes } from './routes/packages';
import { walletRoutes } from './routes/wallet';
import { instapayProofRoutes, instapayRoutes } from './routes/instapay';
import { sharedNumberRoutes } from './routes/shared-number';
import { handleSharedEvent, sharedEnabled, sharedNumberById, sweepShared } from './core/shared/shared-number';
import { secretProblems } from './core/secrets-check';
import { apiContentTypes, requestGuards } from './core/request-guards';
import { applySharedTemplateEvent } from './core/shared/shared-templates';
import { applyAccountEvent, applyHealthEvent } from './core/numbers/health-events';

// The Store link: how to reach the Store, and the words customers see. Inert until STORE_BRIDGE is bound.
// The brand pack (BRAND var; unset = the suite brand) is chosen once per isolate, before any request: copy, templates, agent words,
// and the Store link when the brand has one. An unknown BRAND throws here, so a misconfigured deploy fails instead of showing another brand.
const PACK = brandPack((workerEnv as { BRAND?: string }).BRAND);
if (PACK.storeLink) configureStoreLink(PACK.storeLink);
// Without the copy the agent reports itself inactive for every workspace (agentActive), however its settings are.
configureAgent({ copy: PACK.agentCopy });
const STORE_EVENTS_QUEUE = 'ebda-wa-events';
const SEND_DLQ_QUEUE = 'ebda-wa-send-dlq';

import { WorkspaceDO as WorkspaceDOBase } from './core/workspace-do';
/** The workspace Durable Object, wrapped so its fetch / alarm / RPC errors reach Sentry (iceberg E2). Same class name and methods for the bindings. */
export const WorkspaceDO = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN, release: env.COMMIT_SHA, beforeSend: scrubEvent, tracesSampleRate: 0 }),
  WorkspaceDOBase,
);
export { CampaignWorkflow, ImportWorkflow } from './core/campaigns/workflows';

/**
 * Internal RPC for the accounts service (bind it with `entrypoint: "WhatsAppOtp"`; never a public URL):
 * `sendOtp(storeId, phone, code)`. Off until the store switches `otpViaWhatsApp` on. No UI.
 */
export class WhatsAppOtp extends WorkerEntrypoint<Env> {
  async sendOtp(storeId: string, phone: string, code: string): Promise<OtpResult> {
    return sendOtp(this.env, { storeId, phone, code });
  }
}

const app = new Hono<{ Bindings: Env }>();
// Every request tells alert() the secrets and how to outlive the response (iceberg E1).
app.use('*', async (c, next) => {
  let waitUntil: (p: Promise<unknown>) => void = () => undefined;
  try { const ctx = c.executionCtx; waitUntil = (p) => ctx.waitUntil(p); } catch { /* no execution context (a test calling app.fetch directly) */ }
  bindAlerts({ env: c.env, waitUntil });
  await next();
});
// A route that threw: Sentry sees the exception (iceberg E2), a human is paged once per route class, the caller gets a JSON 500 with nothing in it.
app.onError((err, c) => {
  captureError(err);
  const storeId = c.req.param('storeId');
  alert('unhandled_error', { severity: 'P1', ...(storeId ? { workspace: storeId } : {}), route: c.req.routePath, method: c.req.method, error: errClass(err) });
  return c.json({ error: 'internal' }, 500);
});
// Everything the Worker answers itself (API, webhook, health, tracked links) is JSON, text or a redirect: nothing may load or
// frame it. The page policy lives in web/brands/<brand>/public/_headers (served by static assets, one per brand).
const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};
// Defaults only: a route that chose its own (tracked links: no-referrer; media: a sandboxing CSP) keeps it.
// A WebSocket upgrade answers 101 from the Durable Object with immutable headers; page headers mean nothing on a protocol switch.
app.use('*', async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const missing = Object.entries(SECURITY_HEADERS).filter(([k]) => !c.res.headers.has(k));
  if (!missing.length) return;
  // Response.redirect() and passed-through fetch() responses have immutable headers: copy before setting.
  try {
    for (const [k, v] of missing) c.res.headers.set(k, v);
  } catch {
    const res = new Response(c.res.body, c.res);
    for (const [k, v] of missing) res.headers.set(k, v);
    c.res = res;
  }
});

// Body-size cap, content-type allow-list and the public-route limits, before any route (src/core/request-guards.ts).
app.use('*', requestGuards());

// One verifier per isolate so the JWKS cache survives across requests.
let verifier: IdentityVerifier | undefined;
const getVerifier = (env: Env): IdentityVerifier => (verifier ??= selectVerifier(env).verifier);

const api = new Hono<{ Bindings: Env; Variables: AuthVars }>();
api.use('/stores/:storeId/*', requireStoreAccess(getVerifier));
api.use('/operator/*', requireSuperAdmin(getVerifier));
api.use('*', apiContentTypes()); // after auth: 401/403 first, then 415 for a body type the route class does not take
api.route('/operator', operatorRoutes);
api.get('/stores/:storeId/me', (c) => {
  const p = c.get('principal');
  return c.json({ userId: p.userId, storeId: c.req.param('storeId')!, role: c.get('storeRole'), capabilities: { codOutcome: bridgeFor(c.env) !== null, numbers: signupEnabled(c.env), sharedNumber: sharedEnabled(c.env) } });
});
api.delete('/stores/:storeId/contacts/:waId', async (c) => {
  const role = c.get('storeRole');
  if (role !== 'owner' && role !== 'super_admin') return c.json({ error: 'forbidden' }, 403);
  // Hono has already percent-decoded the param; decoding again would turn a literal % into a 500.
  const e164 = normaliseE164(c.req.param('waId'));
  if (!e164) return c.json({ error: 'invalid phone number' }, 400);
  const storeId = c.req.param('storeId');
  // For Ebda Store stores the workspace id is the store id (Phase 1 ruling). Never touch a DO for an unregistered workspace.
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first();
  if (!known) return c.json({ error: 'workspace not found' }, 404);
  const result = await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId)).eraseContact(e164.slice(1));
  if (!result.found && result.r2Pending === 0) return c.json({ error: 'contact not found' }, 404);
  const who = c.env.SUITE_BUYER_KEY_SECRET ? await buyerKey(c.env.SUITE_BUYER_KEY_SECRET, e164) : `…${e164.slice(-4)}`;
  console.log(JSON.stringify({ audit: 'contact_erased', storeId, by: c.get('principal').userId, buyer: who, ...result }));
  return c.json(result);
});
api.route('/', messagesRoutes);
api.route('/', conversationsRoutes);
api.route('/', realtimeRoutes);
api.route('/', mediaRoutes);
api.route('/', ordersRoutes);
api.route('/', templatesRoutes(PACK.templates));
api.route('/', proofRoutes);
api.route('/', agentRoutes);
api.route('/', connectorRoutes);
api.route('/', contactsRoutes);
api.route('/', importsRoutes);
api.route('/', segmentsRoutes);
api.route('/', campaignsRoutes);
api.route('/', numbersRoutes);
api.route('/', walletRoutes);
api.route('/', instapayRoutes);
api.route('/', instapayProofRoutes);
api.route('/', packageRoutes);
api.route('/', sharedNumberRoutes);
app.route('/api/v1', api);
/** The /api/v1 routes, exported so a test can walk them (every store route needs a scope decision in core/identity/scopes.ts). */
export const apiRoutes = api;

function sameString(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

app.route('/', trackRoutes);

// The card provider's webhook: public, authenticated by its HMAC over the raw body (never by anything in the payload).
app.post('/kashier/webhook', async (c) => {
  const out = await handleProviderWebhook(c.env, await c.req.text(), c.req.header('x-kashier-signature') ?? null);
  return c.text(out.body, out.status);
});

app.get('/health', (c) => {
  const commit = c.env.COMMIT_SHA || 'dev';
  // A malformed or missing secret fails health (so verify-prod catches it at deploy); the key names go to the alert line only.
  const problems = secretProblems(c.env as unknown as Record<string, unknown>);
  if (problems.length) {
    alert('secret_misconfigured', { severity: 'P1', keys: problems });
    return c.json({ ok: false, status: 'misconfigured', service: PACK.service, commit }, 503);
  }
  return c.json({ ok: true, status: 'ok', service: PACK.service, commit });
});

app.get('/meta/webhook', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge') ?? '';
  if (mode === 'subscribe' && token && c.env.META_VERIFY_TOKEN && sameString(token, c.env.META_VERIFY_TOKEN)) return c.text(challenge);
  return c.text('forbidden', 403);
});

app.post('/meta/webhook', async (c) => {
  const raw = await c.req.arrayBuffer();
  if (!(await verifyMetaSignature(raw, c.req.header('x-hub-signature-256') ?? null, c.env.META_APP_SECRET))) {
    return c.text('unauthorized', 401);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    console.warn('meta webhook: body is not JSON');
    return c.text('ok'); // a 5xx would make Meta retry a body that can never parse
  }
  for (const t of extractTemplateStatuses(payload)) {
    await applySharedTemplateEvent(c.env, t.wabaId, t.name, t.language, { status: t.status, reason: t.reason }); // the platform WABA's own catalog (no workspace owns it)
    for (const workspaceId of await workspacesForWaba(c.env.DB, t.wabaId)) {
      await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).applyTemplateStatus(t.name, t.language, t.status, t.reason);
    }
  }
  for (const t of extractTemplateCategoryUpdates(payload)) {
    await applySharedTemplateEvent(c.env, t.wabaId, t.name, t.language, { category: t.newCategory });
    for (const workspaceId of await workspacesForWaba(c.env.DB, t.wabaId)) {
      await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).applyTemplateCategory(t.name, t.language, t.newCategory);
    }
  }
  for (const u of extractTierUpdates(payload)) {
    const tier = TIER_LIMITS[u.currentLimit];
    const number = tier === undefined ? null : await numberForDisplayPhone(c.env.DB, u.wabaId, u.displayPhone);
    if (number && tier !== undefined) await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(number.workspaceId)).setNumberLimits(number.phoneNumberId, { tier });
    if (number) await c.env.DB.prepare('UPDATE phone_numbers SET messaging_limit_tier = ? WHERE phone_number_id = ?').bind(u.currentLimit, number.phoneNumberId).run();
  }
  for (const q of extractQualityEvents(payload)) await applyHealthEvent(c.env, q.wabaId, q.displayPhone, { kind: 'quality', event: q.event }, q.at, (f) => c.executionCtx.waitUntil(f()));
  for (const a of extractAccountEvents(payload)) await applyAccountEvent(c.env, a.wabaId, a.restricted ? { kind: 'restricted' } : { kind: 'restriction_lifted' }, a.at, (f) => c.executionCtx.waitUntil(f()));
  for (const u of extractNameUpdates(payload)) {
    const number = await numberForDisplayPhone(c.env.DB, u.wabaId, u.displayPhone);
    if (!number) continue;
    // The name Meta approved becomes the verified name; a refusal or a wait only changes the status the merchant sees.
    await c.env.DB.prepare('UPDATE phone_numbers SET name_status = ?, verified_name = CASE WHEN ? = 1 THEN coalesce(?, verified_name) ELSE verified_name END WHERE phone_number_id = ?')
      .bind(u.decision, u.decision === 'APPROVED' ? 1 : 0, u.requestedName, number.phoneNumberId).run();
  }
  for (const co of extractCoexistence(payload)) {
    const workspaceId = await workspaceForPhoneNumber(c.env.DB, co.phoneNumberId);
    if (!workspaceId) {
      console.warn('meta webhook: unrouted phone_number_id');
      continue;
    }
    const res = await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).ingestCoexistence({ phoneNumberId: co.phoneNumberId, echoes: co.echoes, history: co.history, contacts: co.contacts });
    // What the merchant sees about the two one-time syncs. A declined history stays declined.
    if (co.historyDeclined) await c.env.DB.prepare("UPDATE phone_numbers SET history_sync = 'declined' WHERE phone_number_id = ?").bind(co.phoneNumberId).run();
    else if (co.history.length) await c.env.DB.prepare("UPDATE phone_numbers SET history_sync = 'received' WHERE phone_number_id = ? AND coalesce(history_sync, '') != 'declined'").bind(co.phoneNumberId).run();
    if (co.contacts.length) await c.env.DB.prepare("UPDATE phone_numbers SET contacts_sync = 'received' WHERE phone_number_id = ?").bind(co.phoneNumberId).run();
    console.log(JSON.stringify({ audit: 'coexistence_ingested', workspace: workspaceId, ...res, declined: co.historyDeclined }));
  }
  const events = extractEvents(payload);
  if (!events) {
    console.warn('meta webhook: unrecognised payload');
    return c.text('ok');
  }
  const receivedAt = Date.now();
  const replies: SendJob[] = [];
  let firstMetaTs = 0;
  for (const ev of events) {
    // The platform number belongs to no one store: routed by who last wrote to the customer. Off = it is an unknown number below.
    if (sharedEnabled(c.env) && (await sharedNumberById(c.env, ev.phoneNumberId))) {
      replies.push(...(await handleSharedEvent(c.env, ev, { receivedAt, copy: PACK.sharedNumber, config: { autoReplyText: PACK.autoReply, optInKeywords: [...PACK.optInKeywords] } })));
      mark(c.env, 'do_stored', 0, Date.now() - receivedAt);
      continue;
    }
    const workspaceId = await workspaceForPhoneNumber(c.env.DB, ev.phoneNumberId);
    if (!workspaceId) {
      console.warn('meta webhook: unrouted phone_number_id');
      mark(c.env, 'unrouted', 0, Date.now() - receivedAt);
      continue;
    }
    const stub = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId));
    // Awaited before the 200: if the DO write fails we answer 5xx and Meta redelivers (ingest is idempotent on wamid).
    const res = await stub.ingest({ ...ev, receivedAt }, { autoReplyText: PACK.autoReply, optInKeywords: [...PACK.optInKeywords] });
    const metaTs = Math.min(...ev.inbound.map((m) => m.ts * 1000));
    if (Number.isFinite(metaTs)) firstMetaTs ||= metaTs;
    mark(c.env, 'do_stored', Number.isFinite(metaTs) ? Date.now() - metaTs : 0, Date.now() - receivedAt, workspaceId);
    replies.push(...res.replies);
  }
  if (replies.length) {
    await c.env.SEND_QUEUE.sendBatch(replies.map((body) => ({ body })));
    mark(c.env, 'enqueued', firstMetaTs ? Date.now() - firstMetaTs : 0, Date.now() - receivedAt, replies[0]!.workspaceId);
  }
  mark(c.env, 'webhook_ack', firstMetaTs ? Date.now() - firstMetaTs : 0, Date.now() - receivedAt);
  return c.text('ok');
});

/** The daily control-plane pass. Each step is independent: one failing never skips the rest. */
export async function dailyBilling(env: Env): Promise<void> {
  await reconcileEntitlements(env).catch((err) => alert('entitlement_reconcile_failed', { error: err instanceof Error ? err.name : 'error' }));
  await repairTopups(env).catch((err) => alert('topup_repair_failed', { error: err instanceof Error ? err.name : 'error' }));
  await reconfirmUnconfirmed(env).catch((err) => alert('webhook_reconfirm_failed', { error: err instanceof Error ? err.name : 'error' }));
  await reconcileCardRefunds(env, paymentProvider(env)).catch((err) => alert('card_refund_reconcile_failed', { error: err instanceof Error ? err.name : 'error' }));
  await sweepAbandonedRefunds(env).catch((err) => alert('refund_abandon_sweep_failed', { error: err instanceof Error ? err.name : 'error' }));
  await expireInstapay(env).catch((err) => alert('instapay_expiry_failed', { error: err instanceof Error ? err.name : 'error' }));
  await repairInstapay(env).catch((err) => alert('instapay_repair_failed', { error: err instanceof Error ? err.name : 'error' }));
  await overdueInstapay(env).catch((err) => alert('instapay_overdue_check_failed', { error: err instanceof Error ? err.name : 'error' }));
  await repairPackageOrders(env).catch((err) => alert('package_repair_failed', { error: err instanceof Error ? err.name : 'error' }));
  await sweepShared(env).catch((err) => alert('shared_sweep_failed', { error: err instanceof Error ? err.name : 'error' }));
}

let warnedNoDsn = false;

export default Sentry.withSentry((env: Env) => {
  if (!env.SENTRY_DSN && !warnedNoDsn) {
    warnedNoDsn = true;
    console.warn('sentry: SENTRY_DSN not set, error tracking is off');
  }
  return env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, release: env.COMMIT_SHA, beforeSend: scrubEvent, tracesSampleRate: 0 } : undefined;
}, {
  fetch: app.fetch,
  /** Daily (the only cron; no polling): re-send subscriptions so a lost push heals. Idempotent by construction. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    bindAlerts({ env, waitUntil: (p) => ctx.waitUntil(p) });
    // The log line is the proof of a real tick (the cron can't be waited on): see docs/runbooks/rollback.md.
    ctx.waitUntil(dailyBilling(env).then(() => console.log(JSON.stringify({ cron: 'daily_billing', done: true }))));
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    bindAlerts({ env, waitUntil: (p) => ctx.waitUntil(p) });
    if (batch.queue === STORE_EVENTS_QUEUE) await consumeStoreEvents(batch, env);
    else if (batch.queue === SEND_DLQ_QUEUE) await consumeSendDlq(batch, env);
    else await consumeSendBatch(batch, env);
  },
} satisfies ExportedHandler<Env>);
