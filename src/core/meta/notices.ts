import type { Env } from '../../env';

/** Owner-visible notices (D1 `workspace_notices`). One kind today: a person who connected a number removed the app (Meta's data-deletion callback). */
export type Notice = { id: number; kind: string; wabaId: string; at: number };

export async function openNotices(env: Env, workspaceId: string): Promise<Notice[]> {
  const { results } = await env.DB.prepare('SELECT id, kind, ref, created_at FROM workspace_notices WHERE workspace_id = ? AND resolved_at IS NULL ORDER BY id LIMIT 50').bind(workspaceId).all<{ id: number; kind: string; ref: string; created_at: number }>();
  return results.map((r) => ({ id: r.id, kind: r.kind, wabaId: r.ref, at: r.created_at }));
}

/** Closes one notice of this workspace. False when it is not open or not this workspace's. */
export async function resolveNotice(env: Env, workspaceId: string, id: number, by: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE workspace_notices SET resolved_at = ?, resolved_by = ? WHERE id = ? AND workspace_id = ? AND resolved_at IS NULL').bind(now, by.slice(0, 64), id, workspaceId).run();
  return r.meta.changes > 0;
}

/** A disconnect of a WABA's number settles the notices about that WABA. */
export async function resolveNoticesForWaba(env: Env, workspaceId: string, wabaId: string, by: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('UPDATE workspace_notices SET resolved_at = ?, resolved_by = ? WHERE workspace_id = ? AND ref = ? AND resolved_at IS NULL').bind(now, by, workspaceId, wabaId).run();
}
