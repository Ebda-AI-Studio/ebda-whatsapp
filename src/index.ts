import { Hono } from 'hono';
import type { Env } from './env';
import { verifyMetaSignature } from './core/meta/signature';
import { extractEvents } from './core/meta/webhook-schema';
import { workspaceForPhoneNumber } from './core/routing';
import type { SendJob } from './core/send-queue';
import { EBDA_COPY } from './addons/ebda/copy';

export { WorkspaceDO } from './core/workspace-do';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, service: 'ebda-wa', commit: c.env.COMMIT_SHA ?? 'dev' }));

app.get('/meta/webhook', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge') ?? '';
  if (mode === 'subscribe' && token && token === c.env.META_VERIFY_TOKEN) return c.text(challenge);
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
  for (const ev of events) {
    const workspaceId = await workspaceForPhoneNumber(c.env.DB, ev.phoneNumberId);
    if (!workspaceId) {
      console.warn('meta webhook: unrouted phone_number_id');
      continue;
    }
    const stub = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId));
    // Awaited before the 200: if the DO write fails we answer 5xx and Meta redelivers (ingest is idempotent on wamid).
    const res = await stub.ingest({ ...ev, receivedAt }, { autoReplyText: EBDA_COPY.spikeAutoReply });
    replies.push(...res.replies);
  }
  return c.text('ok');
});

export default app;
