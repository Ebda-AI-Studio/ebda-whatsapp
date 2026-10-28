import type { Env } from '../../env';

/**
 * The new-workspace campaign cap, beyond one workspace (final review). A single Durable Object only sees its own recipients, so an owner could open workspace after workspace, or several
 * new workspaces could share the one platform number, and send the allowance again each time. The D1 table `new_cap_usage` holds what a still-capped workspace reserved (one row per
 * page, `ref` = the page, so a retried page is idempotent), tagged with the workspace's Store OWNER (`workspace_owners`, fed by the Store's events) and its number. The cap is checked per
 * scope: the rolling 24 h total of the owner across their workspaces, and of the phone number across its workspaces, each against the same allowance.
 * The check and the write are ONE statement (`reserveNewCap`, ruling NEW-CAP-ATOMIC-1, docs/rulings/NEW-CAP-ATOMIC-1.md); `newCapUsage` is only a cheap pre-check for how much room to ask for. A workspace without an owner row sends no campaigns.
 * STALENESS CLASS: NEVER-stale in the safe direction: usage is written BEFORE the page is queued and is never reduced, so a failed page overcounts for 24 h, never undercounts.
 */
export async function recordWorkspaceOwner(env: Pick<Env, 'DB'>, workspaceId: string, ownerUserId: string, now: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET owner_user_id = excluded.owner_user_id, updated_at = excluded.updated_at',
  ).bind(workspaceId, ownerUserId.slice(0, 120), now).run();
}

/**
 * The largest rolling usage of the scopes this workspace belongs to, and when the oldest of those rows started. Scopes: its owner, its workspace, and its number ONLY when the number
 * is a tenant's own (`phone_numbers.kind = 'own'`): the shared platform number pools strangers, so a number scope there would let one tenant exhaust the allowance for all (cross-tenant DoS).
 */
export async function newCapUsage(env: Pick<Env, 'DB'>, workspaceId: string, phoneNumberId: string, since: number): Promise<{ used: number; first: number | null }> {
  const owner = await env.DB.prepare('SELECT owner_user_id FROM workspace_owners WHERE workspace_id = ?').bind(workspaceId).first<{ owner_user_id: string }>();
  const own = await env.DB.prepare("SELECT 1 AS x FROM phone_numbers WHERE phone_number_id = ? AND kind = 'own'").bind(phoneNumberId).first();
  const [byOwner, byWorkspace, byNumber] = await env.DB.batch([
    env.DB.prepare('SELECT coalesce(sum(n), 0) AS used, min(at) AS first FROM new_cap_usage WHERE owner_user_id = ? AND at > ?').bind(owner?.owner_user_id ?? '', since),
    env.DB.prepare('SELECT coalesce(sum(n), 0) AS used, min(at) AS first FROM new_cap_usage WHERE workspace_id = ? AND at > ?').bind(workspaceId, since),
    env.DB.prepare('SELECT coalesce(sum(n), 0) AS used, min(at) AS first FROM new_cap_usage WHERE phone_number_id = ? AND at > ?').bind(own ? phoneNumberId : '', since),
  ]);
  const rows = [byOwner!, byWorkspace!, byNumber!].map((r) => (r.results[0] ?? { used: 0, first: null }) as { used: number; first: number | null });
  return rows.reduce((m, r) => (r.used > m.used ? r : m));
}

/**
 * Reserves `n` recipients of one page against both scopes in ONE conditional statement (ruling NEW-CAP-ATOMIC-1): the row is inserted only if the workspace has an owner row AND
 * owner-sum + n <= cap AND workspace-sum + n <= cap AND (number-sum + n <= cap when the number is a tenant's OWN number; the shared platform number has no number scope), so two workspaces of one owner (or on one number) cannot both read "room" and then both insert. D1 runs a statement atomically; the
 * caller sends ONLY when this says `ok`. A retried `ref` is idempotent (already reserved = ok). No owner row = refused with `no_owner` (fail closed, never counted as zero usage).
 * Throws on a D1 failure (the campaign step then retries: fail closed).
 */
export async function reserveNewCap(
  env: Pick<Env, 'DB'>,
  a: { workspaceId: string; phoneNumberId: string; ref: string; n: number; now: number; cap: number; since: number },
): Promise<{ ok: true } | { ok: false; reason: 'cap_reached' | 'no_owner' }> {
  const r = await env.DB.prepare(
    `INSERT INTO new_cap_usage (ref, workspace_id, owner_user_id, phone_number_id, n, at)
     SELECT ?1, ?2, o.owner_user_id, ?3, ?4, ?5 FROM workspace_owners o
     WHERE o.workspace_id = ?2
       AND NOT EXISTS (SELECT 1 FROM new_cap_usage WHERE ref = ?1)
       AND (SELECT coalesce(sum(n), 0) FROM new_cap_usage WHERE owner_user_id = o.owner_user_id AND at > ?6) + ?4 <= ?7
       AND (SELECT coalesce(sum(n), 0) FROM new_cap_usage WHERE workspace_id = ?2 AND at > ?6) + ?4 <= ?7
       AND (NOT EXISTS (SELECT 1 FROM phone_numbers WHERE phone_number_id = ?3 AND kind = 'own')
            OR (SELECT coalesce(sum(n), 0) FROM new_cap_usage WHERE phone_number_id = ?3 AND at > ?6) + ?4 <= ?7)`,
  ).bind(a.ref, a.workspaceId, a.phoneNumberId, a.n, a.now, a.since, a.cap).run();
  if (r.meta.changes > 0) return { ok: true };
  const existing = await env.DB.prepare('SELECT 1 AS x FROM new_cap_usage WHERE ref = ?').bind(a.ref).first();
  if (existing) return { ok: true }; // the same page retried: its reservation stands
  const owner = await env.DB.prepare('SELECT 1 AS x FROM workspace_owners WHERE workspace_id = ?').bind(a.workspaceId).first();
  return { ok: false, reason: owner ? 'cap_reached' : 'no_owner' };
}

/** Daily pass: usage older than two days no longer matters. */
export async function purgeNewCapUsage(env: Pick<Env, 'DB'>, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM new_cap_usage WHERE at < ?').bind(now - 2 * 86_400_000).run();
}
