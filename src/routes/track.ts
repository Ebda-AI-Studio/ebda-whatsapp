import { Hono } from 'hono';
import type { Env } from '../env';
import { isAutomatedFetch, parseCode } from '../core/campaigns/links';

export const trackRoutes = new Hono<{ Bindings: Env }>();

const known = new Map<string, number>();
const KNOWN_TTL_MS = 60_000;

const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' } });

/**
 * A recipient's tracked link. Public by design: the 128-bit code is the credential. A code that is not even shaped right, or names a
 * workspace we do not have, is a 404 before any Durable Object is touched. The answer is a 302 that is never cached (each click is
 * counted, and an erased contact's link must stop working at once).
 */
trackRoutes.get('/t/:code', async (c) => {
  const parsed = parseCode(c.req.param('code'));
  if (!parsed) return notFound();
  const now = Date.now();
  if ((known.get(parsed.workspaceId) ?? 0) <= now) {
    const row = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(parsed.workspaceId).first();
    if (!row) return notFound();
    known.set(parsed.workspaceId, now + KNOWN_TTL_MS);
  }
  const ws = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(parsed.workspaceId));
  const hit = await ws.recordClick(parsed.code, !isAutomatedFetch(c.req.header('user-agent'), c.req.method));
  if (!hit) return notFound();
  return new Response(null, { status: 302, headers: { location: hit.url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });
});
