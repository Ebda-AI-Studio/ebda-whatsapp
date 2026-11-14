/**
 * A store on the SHARED number (no own number) cannot make templates on the platform WABA. It sees the platform's sendable ones and asks the platform
 * team for a utility or authentication one (Ruling WA-SHARED-NOCAMP-1: marketing is never sendable from the shared number, so it is never requestable).
 * The team answers through the existing operator submit, which marks the matching open request `done`.
 */
import type { Env } from '../../env';
import type { SharedRequestDto, SharedTemplateDto } from '../api/contract';
import { listSharedTemplates } from './shared-templates';
import { currentSharedNumber, senderNumberFor } from './shared-number';

export const MAX_OPEN_SHARED_REQUESTS = 5;
const SENDABLE = ['UTILITY', 'AUTHENTICATION'];

/** The shared number this store sends from, or null (own number, not a member, switch off): every store-facing route answers 404 then. */
export async function sharedNumberOf(env: Env, workspaceId: string): Promise<{ phoneNumberId: string; wabaId: string } | null> {
  const n = await senderNumberFor(env, workspaceId);
  return n?.shared ? { phoneNumberId: n.phoneNumberId, wabaId: n.wabaId } : null;
}

/** What a store may use from the platform catalogue right now: APPROVED and utility or authentication, name + text + parameter count only. */
export async function sharedTemplatesFor(env: Env): Promise<SharedTemplateDto[]> {
  const number = await currentSharedNumber(env);
  if (!number) return [];
  return (await listSharedTemplates(env, number))
    .filter((t) => t.status === 'APPROVED' && SENDABLE.includes(t.category))
    .map((t) => ({ name: t.name, language: t.language, category: t.category as SharedTemplateDto['category'], bodyText: t.bodyText, paramCount: t.paramCount }));
}

type Row = { id: string; workspace_id: string; name: string; language: string; category: string; body: string; status: string; created_at: number; decided_at: number | null };
const dto = (r: Row): SharedRequestDto => ({ id: r.id, name: r.name, language: r.language, category: r.category as SharedRequestDto['category'], body: r.body, status: r.status as SharedRequestDto['status'], createdAt: r.created_at, decidedAt: r.decided_at });

export async function listRequests(env: Env, workspaceId: string): Promise<SharedRequestDto[]> {
  const { results } = await env.DB.prepare('SELECT id, workspace_id, name, language, category, body, status, created_at, decided_at FROM shared_template_requests WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT 50').bind(workspaceId).all<Row>();
  return results.map(dto);
}

/** Every request, newest first, with the workspace that asked (operator console). */
export async function listAllRequests(env: Env, status?: string): Promise<(SharedRequestDto & { workspaceId: string })[]> {
  const { results } = await env.DB.prepare(`SELECT id, workspace_id, name, language, category, body, status, created_at, decided_at FROM shared_template_requests ${status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC, id LIMIT 200`).bind(...(status ? [status] : [])).all<Row>();
  return results.map((r) => ({ ...dto(r), workspaceId: r.workspace_id }));
}

/**
 * Records an ask. The cap is checked and the row inserted in ONE statement, so two taps at once cannot both pass it.
 * `limit` = already 5 open ones for this store.
 */
export async function createRequest(env: Env, workspaceId: string, r: { name: string; language: string; category: 'UTILITY' | 'AUTHENTICATION'; body: string }, now = Date.now()): Promise<{ ok: true; request: SharedRequestDto } | { ok: false; reason: 'limit' }> {
  const id = crypto.randomUUID();
  const ins = await env.DB.prepare(
    `INSERT INTO shared_template_requests (id, workspace_id, name, language, category, body, status, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7 WHERE (SELECT count(*) FROM shared_template_requests WHERE workspace_id = ?2 AND status = 'open') < ?8`,
  ).bind(id, workspaceId, r.name, r.language, r.category, r.body, now, MAX_OPEN_SHARED_REQUESTS).run();
  if (!ins.meta.changes) return { ok: false, reason: 'limit' };
  return { ok: true, request: { id, name: r.name, language: r.language, category: r.category, body: r.body, status: 'open', createdAt: now, decidedAt: null } };
}

/** The team made the template: every open request for that name and language is done. */
export async function markRequestsDone(env: Env, name: string, language: string, now = Date.now()): Promise<void> {
  await env.DB.prepare("UPDATE shared_template_requests SET status = 'done', decided_at = ? WHERE name = ? AND language = ? AND status = 'open'").bind(now, name, language).run();
}
