import { Hono } from 'hono';
import type { Env } from './env';
import { verifyMetaSignature } from './core/meta/signature';

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
  return c.text('ok');
});

export default app;
