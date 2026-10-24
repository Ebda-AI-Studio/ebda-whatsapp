import { Hono } from 'hono';
import type { Env } from './env';
import { verifyMetaSignature } from './core/meta/signature';
import { extractEvents } from './core/meta/webhook-schema';
import { workspaceForPhoneNumber } from './core/routing';
import { mark } from './core/timing';
import { consumeSendBatch, type SendJob } from './core/send-queue';
import { EBDA_COPY } from './addons/ebda/copy';
import { createEbdaAccountsVerifier } from './addons/ebda/identity';
import { requireStoreAccess, type AuthVars } from './core/identity/middleware';
import type { IdentityVerifier } from './core/identity/verifier';

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
    const res = await stub.ingest({ ...ev, receivedAt }, { autoReplyText: EBDA_COPY.spikeAutoReply });
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

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await consumeSendBatch(batch, env);
  },
} satisfies ExportedHandler<Env>;
