import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import type { Env } from './env';
import { selectVerifier } from './identity-select';
import { configureAgent } from './core/ai/config';
import { signupEnabled } from './core/numbers/numbers';
import { verifyMetaSignature } from './core/meta/signature';
import { extractCoexistence, extractEvents, extractNameUpdates, extractTemplateStatuses, extractTierUpdates } from './core/meta/webhook-schema';
import { numberForDisplayPhone, workspaceForPhoneNumber, workspacesForWaba } from './core/routing';
import { mark } from './core/timing';
import { scrubEvent } from './core/observability';
import { consumeSendBatch, type SendJob } from './core/send-queue';
import { EBDA_AGENT_COPY } from './addons/ebda/agent-copy';
import { EBDA_COPY } from './addons/ebda/copy';
import { EBDA_OPT_IN_KEYWORDS } from './addons/ebda/consent';
import { requireStoreAccess, type AuthVars } from './core/identity/middleware';
import type { IdentityVerifier } from './core/identity/verifier';
import { normaliseE164 } from './core/phone';
import { TIER_LIMITS } from './core/throttle';
import { buyerKey } from './core/buyer-key';
import { messagesRoutes } from './routes/messages';
import { conversationsRoutes } from './routes/conversations';
import { mediaRoutes } from './routes/media';
import { realtimeRoutes } from './routes/ws';
import { templatesRoutes } from './routes/templates';
import { EBDA_DEFAULT_TEMPLATES } from './addons/ebda/templates';
import { EBDA_ORDERING_COPY } from './addons/ebda/store-copy';
import { EBDA_OTP_POLICY } from './addons/ebda/otp-policy';
import { createServiceBindingBridge } from './addons/ebda/store-bridge';
import { configureStoreLink } from './core/store-link';
import { consumeStoreEvents } from './core/store-events';
import { sendOtp, type OtpResult } from './core/otp';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createStoreEventSink } from './addons/ebda/store-events';
import { bridgeFor } from './core/store-link';
import { ordersRoutes } from './routes/orders';
import { proofRoutes } from './routes/proof';
import { agentRoutes } from './routes/agent';
import { contactsRoutes } from './routes/contacts';
import { importsRoutes } from './routes/imports';
import { segmentsRoutes } from './routes/segments';
import { campaignsRoutes } from './routes/campaigns';
import { trackRoutes } from './routes/track';
import { numbersRoutes } from './routes/numbers';

// The Store link: how to reach the Store, and the words customers see. Inert until STORE_BRIDGE is bound.
configureStoreLink({ bridge: createServiceBindingBridge, events: createStoreEventSink, copy: EBDA_ORDERING_COPY, otp: EBDA_OTP_POLICY });
// Without the copy the agent reports itself inactive for every workspace (agentActive), however its settings are.
configureAgent({ copy: EBDA_AGENT_COPY });
const STORE_EVENTS_QUEUE = 'ebda-wa-events';

export { WorkspaceDO } from './core/workspace-do';
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
// Everything the Worker answers itself (API, webhook, health, tracked links) is JSON, text or a redirect: nothing may load or
// frame it. The SPA's own policy lives in web/public/_headers (served by static assets).
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

// One verifier per isolate so the JWKS cache survives across requests.
let verifier: IdentityVerifier | undefined;
const getVerifier = (env: Env): IdentityVerifier => (verifier ??= selectVerifier(env).verifier);

const api = new Hono<{ Bindings: Env; Variables: AuthVars }>();
api.use('/stores/:storeId/*', requireStoreAccess(getVerifier));
api.get('/stores/:storeId/me', (c) => {
  const p = c.get('principal');
  return c.json({ userId: p.userId, storeId: c.req.param('storeId')!, role: c.get('storeRole'), capabilities: { codOutcome: bridgeFor(c.env) !== null, numbers: signupEnabled(c.env) } });
});
api.delete('/stores/:storeId/contacts/:waId', async (c) => {
  const role = c.get('storeRole');
  if (role !== 'owner' && role !== 'super_admin') return c.json({ error: 'forbidden' }, 403);
  // Hono has already percent-decoded the param; decoding again would turn a literal % into a 500.
  const e164 = normaliseE164(c.req.param('waId'));
  if (!e164) return c.json({ error: 'invalid phone number' }, 400);
  const storeId = c.req.param('storeId');
  // For Ebda stores the workspace id is the store id (Phase 1 ruling). Never touch a DO for an unregistered workspace.
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
api.route('/', templatesRoutes(EBDA_DEFAULT_TEMPLATES));
api.route('/', proofRoutes);
api.route('/', agentRoutes);
api.route('/', contactsRoutes);
api.route('/', importsRoutes);
api.route('/', segmentsRoutes);
api.route('/', campaignsRoutes);
api.route('/', numbersRoutes);
app.route('/api/v1', api);

function sameString(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

app.route('/', trackRoutes);

app.get('/health', (c) => c.json({ ok: true, service: 'ebda-wa', commit: c.env.COMMIT_SHA ?? 'dev' }));

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
    for (const workspaceId of await workspacesForWaba(c.env.DB, t.wabaId)) {
      await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).applyTemplateStatus(t.name, t.language, t.status, t.reason);
    }
  }
  for (const u of extractTierUpdates(payload)) {
    const tier = TIER_LIMITS[u.currentLimit];
    const number = tier === undefined ? null : await numberForDisplayPhone(c.env.DB, u.wabaId, u.displayPhone);
    if (number && tier !== undefined) await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(number.workspaceId)).setNumberLimits(number.phoneNumberId, { tier });
    if (number) await c.env.DB.prepare('UPDATE phone_numbers SET messaging_limit_tier = ? WHERE phone_number_id = ?').bind(u.currentLimit, number.phoneNumberId).run();
  }
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
    const workspaceId = await workspaceForPhoneNumber(c.env.DB, ev.phoneNumberId);
    if (!workspaceId) {
      console.warn('meta webhook: unrouted phone_number_id');
      mark(c.env, 'unrouted', 0, Date.now() - receivedAt);
      continue;
    }
    const stub = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId));
    // Awaited before the 200: if the DO write fails we answer 5xx and Meta redelivers (ingest is idempotent on wamid).
    const res = await stub.ingest({ ...ev, receivedAt }, { autoReplyText: EBDA_COPY.spikeAutoReply, optInKeywords: [...EBDA_OPT_IN_KEYWORDS] });
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

let warnedNoDsn = false;

export default Sentry.withSentry((env: Env) => {
  if (!env.SENTRY_DSN && !warnedNoDsn) {
    warnedNoDsn = true;
    console.warn('sentry: SENTRY_DSN not set, error tracking is off');
  }
  return env.SENTRY_DSN ? { dsn: env.SENTRY_DSN, release: env.COMMIT_SHA, beforeSend: scrubEvent, tracesSampleRate: 0 } : undefined;
}, {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === STORE_EVENTS_QUEUE) await consumeStoreEvents(batch, env);
    else await consumeSendBatch(batch, env);
  },
} satisfies ExportedHandler<Env>);
