import type { Env } from '../../env';

/**
 * The new-workspace campaign cap, beyond one workspace (final review). A single Durable Object only sees its own recipients, so an owner could open workspace after workspace, or several
 * new workspaces could share the one platform number, and send the allowance again each time. The D1 table `new_cap_usage` holds what a still-capped workspace reserved (one row per
 * page, `ref` = the page, so a retried page is idempotent), tagged with the workspace's Store OWNER (`workspace_owners`, fed by the Store's events) and its number. The cap is checked per
 * scope: the rolling 24 h total of the owner across their workspaces, and of the phone number across its workspaces, each against the same allowance.
 * STALENESS CLASS: NEVER-stale in the safe direction: usage is written BEFORE the page is queued and is never reduced, so a failed page overcounts for 24 h, never undercounts.
 */
export async function recordWorkspaceOwner(env: Pick<Env, 'DB'>, workspaceId: string, ownerUserId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, updated_at = excluded.updated_at',
  ).bind(workspaceId, ownerUserId.slice(0, 120), now).run();
}

/** The largest rolling usage of the two scopes this workspace belongs to (its owner, its number), and when the oldest of those rows started. */
export async function newCapUsage(env: Pick<Env, 'DB'>, workspaceId: string, phoneNumberId: string, since: number): Promise<{ used: number; first: number | null }> {
  const owner = await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(workspaceId).first<{ owner_user_id: string }>();
  const [byOwner, byNumber] = await env.DB.batch([
    env.DB.prepare('SELECT coalesce(sum(n), 0) AS used, min(at) AS first FROM new_cap_usage WHERE owner_user_id = ? AND at > ?').bind(owner?.owner_user_id ?? '', since),
    env.DB.prepare('SELECT coalesce(sum(n), 0) AS used, min(at) AS first FROM new_cap_usage WHERE phone_number_id = ? AND at > ?').bind(phoneNumberId, since),
  ]);
  const a = (byOwner!.results[0] ?? { used: 0, first: null }) as { used: number; first: number | null };
  const b = (byNumber!.results[0] ?? { used: 0, first: null }) as { used: number; first: number | null };
  return a.used >= b.used ? a : b;
}

/** Reserves `n` recipients of one page against both scopes. Idempotent per `ref`. Throws on a D1 failure (the campaign step then retries: fail closed). */
export async function reserveNewCap(env: Pick<Env, 'DB'>, a: { workspaceId: string; phoneNumberId: string; ref: string; n: number; now: number }): Promise<void> {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO new_cap_usage (ref, workspace_id, owner_user_id, phone_number_id, n, at) VALUES (?, ?, (SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?), ?, ?, ?)',
  ).bind(a.ref, a.workspaceId, a.workspaceId, a.phoneNumberId, a.n, a.now).run();
}

/** Daily pass: usage older than two days no longer matters. */
export async function purgeNewCapUsage(env: Pick<Env, 'DB'>, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM new_cap_usage WHERE at < ?').bind(now - 2 * 86_400_000).run();
}
