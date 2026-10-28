import { routePath } from 'hono/route';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import type { AuthVars } from './identity/middleware';
import { subjectHash } from './erasure';
import { alert, maskPhones } from './observability';

/**
 * The audit log (T8): who did what, to which ids, when. One middleware records every state-changing call under /api/v1 (owner, staff, server
 * token, operator); explicit `recordAudit` calls cover what a route does not show. Ids and counts only: never a phone number (a `waId` target is
 * stored as its keyed hash), a request body, or a reason text.
 *
 * Ruling AUDIT-OPEN-1 - a failed audit write never fails the action; it raises `audit_write_failed` (P1). Blocking merchants on our own log is worse than a
 * gap a human is told about. Cost if wrong: an action during a D1 outage has no row; the Worker log line (`audit`) still names it.
 */
export type AuditRole = 'owner' | 'staff' | 'operator' | 'integration' | 'system';
export type AuditEntry = {
  workspaceId?: string | null; actor: string; role: AuditRole; action: string; targetType?: string | null; targetId?: string | null; detail?: Record<string, string | number | boolean | null>; status?: number;
  /** Free text an operator typed (AUDIT-RETENTION-1): never in the append-only log; kept, phone numbers masked, in the deletable `audit_reasons`. */
  reason?: string;
};
/** `detail` is for structured facts only: a key like these would carry free text (and a phone number) into a table nothing can edit. */
const FREE_TEXT_KEY = /^(reason|note|notes|text|message|body|comment|caption)$/i;

/** High-volume routes whose every call would swamp the log; the content they touch is already in the workspace. */
const SKIP = [/^POST \/stores\/:storeId\/conversations\/:conversationId\/messages$/, /^POST \/stores\/:storeId\/conversations\/:conversationId\/read$/, /^POST \/stores\/:storeId\/media$/];
const PHONE_LIKE = /^\+?\d{8,}$/;

export async function recordAudit(env: Env, e: AuditEntry, now = Date.now()): Promise<void> {
  try {
    // A keyed subject hash (32 hex) is not a phone: masking it would corrupt about 1 in 50 of them (an 8-digit run inside the hex).
    const targetId = e.targetId == null ? null : /^[0-9a-f]{32}$/.test(e.targetId) ? e.targetId : (maskPhones(e.targetId) ?? null)?.slice(0, 128) ?? null;
    const detail = e.detail ? Object.fromEntries(Object.entries(e.detail).filter(([k]) => !FREE_TEXT_KEY.test(k))) : null;
    const stmts = [
      env.DB.prepare('INSERT INTO audit_log (at, workspace_id, actor, actor_role, action, target_type, target_id, detail, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(now, e.workspaceId ?? null, e.actor, e.role, e.action.slice(0, 200), e.targetType ?? null, targetId, detail && Object.keys(detail).length ? JSON.stringify(detail) : null, e.status ?? 200),
      ...(e.reason && e.workspaceId ? [env.DB.prepare('INSERT INTO audit_reasons (at, workspace_id, actor, action, reason) VALUES (?, ?, ?, ?, ?)').bind(now, e.workspaceId, e.actor, e.action.slice(0, 200), e.reason.slice(0, 300))] : []),
    ];
    await env.DB.batch(stmts);
    console.log(JSON.stringify({ audit: 'action', workspace: e.workspaceId ?? null, role: e.role, action: e.action, status: e.status ?? 200 }));
  } catch {
    alert('audit_write_failed', { ...(e.workspaceId ? { workspace: e.workspaceId } : {}), action: e.action });
  }
}

/** Mount once on the /api/v1 app, after authentication. */
export function auditWrites(): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    await next();
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const principal = c.get('principal');
    if (!principal) return; // unauthenticated: nobody to name
    const status = c.res.status;
    if (!(status < 400 || status === 403)) return;
    const pattern = routePath(c, -1).replace(/^\/api\/v1/, '');
    const action = `${method} ${pattern}`;
    if (SKIP.some((re) => re.test(action))) return;
    const params = c.req.param() as Record<string, string>;
    const workspaceId = params.storeId ?? params.workspaceId ?? null;
    const role: AuditRole = principal.integration ? 'integration' : pattern.startsWith('/operator') ? 'operator' : c.get('storeRole') === 'staff' ? 'staff' : c.get('storeRole') === 'owner' ? 'owner' : 'operator';
    const target = Object.entries(params).find(([k]) => k !== 'storeId' && k !== 'workspaceId');
    let targetId = target?.[1] ?? null;
    if (target && (target[0] === 'waId' || PHONE_LIKE.test(target[1]))) targetId = workspaceId ? await subjectHash(c.env, workspaceId, target[1].replace(/^\+/, '')) : null;
    await recordAudit(c.env, { workspaceId, actor: principal.integration ? `client:${principal.integration.clientId}` : principal.userId, role, action, targetType: target?.[0] ?? null, targetId, status }, Date.now());
  };
}

export type AuditRow = { id: number; at: number; workspaceId: string | null; actor: string; actorRole: AuditRole; action: string; targetType: string | null; targetId: string | null; status: number };
export async function listAudit(env: Env, f: { workspaceId?: string; actor?: string; action?: string; before?: number; limit: number }): Promise<AuditRow[]> {
  const where: string[] = [];
  const p: (string | number)[] = [];
  if (f.workspaceId) { where.push('workspace_id = ?'); p.push(f.workspaceId); }
  if (f.actor) { where.push('actor = ?'); p.push(f.actor); }
  if (f.action) { where.push('action = ?'); p.push(f.action); }
  if (f.before) { where.push('id < ?'); p.push(f.before); }
  const { results } = await env.DB.prepare(`SELECT id, at, workspace_id, actor, actor_role, action, target_type, target_id, status FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).bind(...p, f.limit)
    .all<{ id: number; at: number; workspace_id: string | null; actor: string; actor_role: AuditRole; action: string; target_type: string | null; target_id: string | null; status: number }>();
  return results.map((r) => ({ id: r.id, at: r.at, workspaceId: r.workspace_id, actor: r.actor, actorRole: r.actor_role, action: r.action, targetType: r.target_type, targetId: r.target_id, status: r.status }));
}
export type { Context };
