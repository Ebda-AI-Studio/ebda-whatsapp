import { Hono } from 'hono';
import { auditTrailQuery } from '../core/api/contract';
import { listAudit } from '../core/audit';
import { apiError, type ApiEnv } from './shared';

export const auditTrailRoutes = new Hono<ApiEnv>();

/**
 * The merchant's own audit trail (capability compliance.audit-trail): who changed what in THIS workspace, newest first. Owner only, scoped to the store in
 * the path by the query itself (never a store the caller names in a filter), and it shows the action, who (role + user id), when and the result: never the
 * target id (a customer is stored as a keyed hash that means nothing to the merchant) and never a body or a number.
 */
auditTrailRoutes.get('/stores/:storeId/audit', async (c) => {
  if (c.get('storeRole') !== 'owner') return apiError(c, 403, 'forbidden');
  const q = auditTrailQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const rows = await listAudit(c.env, { workspaceId: c.req.param('storeId')!, ...(q.data.before !== undefined ? { before: q.data.before } : {}), limit: q.data.limit + 1 });
  const page = rows.slice(0, q.data.limit);
  c.header('cache-control', 'no-store');
  return c.json({
    items: page.map((r) => ({ id: r.id, at: r.at, actor: r.actor, role: r.actorRole, action: r.action, status: r.status })),
    nextBefore: rows.length > q.data.limit ? page[page.length - 1]!.id : null,
  });
});
