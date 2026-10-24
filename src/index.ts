import { Hono } from 'hono';
import type { Env } from './env';

export { WorkspaceDO } from './core/workspace-do';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true, service: 'ebda-wa', commit: c.env.COMMIT_SHA ?? 'dev' }));

export default app;
