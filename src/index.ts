import * as Sentry from '@sentry/cloudflare';
import { Hono } from 'hono';
import type { Env } from './env';
import { verifyMetaSignature } from './core/meta/signature';
import { extractEvents, extractTemplateStatuses, extractTierUpdates } from './core/meta/webhook-schema';
import { numberForDisplayPhone, workspaceForPhoneNumber, workspacesForWaba } from './core/routing';
import { mark } from './core/timing';
import { scrubEvent } from './core/observability';
import { consumeSendBatch, type SendJob } from './core/send-queue';
import { EBDA_COPY } from './addons/ebda/copy';
import { EBDA_OPT_IN_KEYWORDS } from './addons/ebda/consent';
import { createEbdaAccountsVerifier } from './addons/ebda/identity';
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
import { createServiceBindingBridge } from './addons/ebda/store-bridge';
import { configureStoreLink } from './core/store-link';
import { consumeStoreEvents } from './core/store-events';

// The Store link: how to reach the Store, and the words customers see. Inert until STORE_BRIDGE is bound.
configureStoreLink({ bridge: createServiceBindingBridge, copy: EBDA_ORDERING_COPY });
const STORE_EVENTS_QUEUE = 'ebda-wa-events';

export { WorkspaceDO } from './core/workspace-do';

const app = new Hono<{ Bindings: Env }>();

// One verifier per isolate so the JWKS cache survives across requests.
let verifier: IdentityVerifier | undefined;
const getVerifier = (env: Env): IdentityVerifier =>
  (verifier ??= createEbdaAccountsVerifier({ jwksUrl: env.IDENTITY_JWKS_URL, issuer: env.IDENTITY_ISSUER, audience: env.IDENTITY_AUDIENCE }));

const api = new Hono<{ Bindings: Env; Variables: AuthVars }>();
api.use('/stores/:storeId/*', requireStoreAccess(getVerifier));
api.get('/stores/:storeId/me', (c) => {
  const p = c.get('principal');
  return c.json({ userId: p.userId, storeId: c.req.param('storeId'), role: c.get('storeRole') });
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
api.route('/', templatesRoutes(EBDA_DEFAULT_TEMPLATES));
app.route('/api/v1', api);

function sameString(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

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
