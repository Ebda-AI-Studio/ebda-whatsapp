/**
 * Ruling CHAT-ENABLE-1: a Chat workspace exists only because a store OWNER chose to connect Chat. This is the ONE place that creates the registry row
 * (`workspaces`, the row every store route resolves the store through) and records the owner; every consent path goes through it, nothing creates a row on a visit.
 *
 * What enabling starts: the registry row and the owner row, nothing else. No charge (money moves only through the plan / wallet flows the owner starts), no trial clock;
 * the only clock is the new-workspace campaign cap (campaigns.md: first 14 days after the workspace's Durable Object first runs). The plan comes from the Store's own plan event.
 */
import type { Env } from '../env';
import { recordWorkspaceOwner } from './campaigns/new-cap';
import { isStandaloneId, mintStandaloneId } from './workspace-kind';

const NAME_MAX = 100;

export type EnsureResult = 'created' | 'exists';

/**
 * Idempotent. `name` is display text from the Store (never trusted for anything else); an existing row keeps its name. The owner row is refreshed on every call (the Store
 * confirmed this user as the owner right before). The caller has ALREADY verified the owner against the Store: this function trusts nothing it is not given and checks nothing it cannot.
 */
export async function ensureWorkspace(env: Pick<Env, 'DB'>, a: { storeId: string; ownerUserId: string; name: string | null }, now = Date.now()): Promise<EnsureResult> {
  // CHAT-SA-2: this function registers STORE workspaces only; a standalone id (`sw_...`) is minted by `createStandaloneWorkspace`, never accepted from a caller or a Store event.
  if (isStandaloneId(a.storeId) || a.storeId.startsWith('sw_')) throw new Error('standalone_id_refused');
  const name = (a.name ?? '').trim().slice(0, NAME_MAX) || a.storeId;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(a.storeId, name, now).run();
  await recordWorkspaceOwner(env, a.storeId, a.ownerUserId, now);
  const created = (r.meta.changes ?? 0) > 0;
  if (created) console.log(JSON.stringify({ audit: 'workspace_enabled', storeId: a.storeId, ownerUserId: a.ownerUserId.slice(0, 120) }));
  return created ? 'created' : 'exists';
}

export type CreateStandaloneResult = { status: 'created'; id: string } | { status: 'already_owns' } | { status: 'invite_invalid' };

/**
 * CHAT-SA-3: creates a standalone workspace (Chat-minted `sw_` id) for a verified person. ONE D1 batch, so the invite, the registry row, the owner membership and the campaign-cap owner
 * row land together or not at all (D1 batches are transactions, and two concurrent calls are serialised: the loser sees the winner's rows):
 *  (a) the invite (when one is given) is consumed only if it is unused, unrevoked, unexpired AND the user does not already own a standalone workspace (a refused call never burns a code);
 *  (b) the workspace row exists only if the user owns no active standalone workspace and the invite (if any) was just consumed by this user at this instant;
 *  (c)(d)(e) the owner membership, the `workspace_owners` row and the invite's `used_workspace_id` are written only if (b) inserted the row.
 * The caller decides who may create (flag, session, rate limit) before calling; this function owns only the atomic write.
 */
export async function createStandaloneWorkspace(
  env: Pick<Env, 'DB'>,
  a: { ownerUserId: string; name: string; country: 'EG'; inviteCodeHash: string | null },
  now = Date.now(),
): Promise<CreateStandaloneResult> {
  const name = a.name.trim().slice(0, NAME_MAX);
  if (!name) throw new Error('invalid_name');
  const owner = a.ownerUserId.slice(0, 120);
  const id = mintStandaloneId();
  const hash = a.inviteCodeHash;
  const OWNS =
    "SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active' AND w.kind = 'standalone'";
  const created = 'SELECT 1 FROM workspaces WHERE id = ?';
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE standalone_invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND NOT EXISTS (${OWNS})`,
    ).bind(now, owner, hash ?? '', now, owner),
    env.DB.prepare(
      `INSERT INTO workspaces (id, name, created_at, kind, country) SELECT ?, ?, ?, 'standalone', ? WHERE NOT EXISTS (${OWNS})
       AND (? IS NULL OR EXISTS (SELECT 1 FROM standalone_invites WHERE code_hash = ? AND used_by = ? AND used_at = ?))`,
    ).bind(id, name, now, a.country, owner, hash, hash, owner, now),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) SELECT ?, ?, 'owner', 'active', ?, ?, ? WHERE EXISTS (${created})`).bind(id, owner, owner, now, now, id),
    env.DB.prepare(`INSERT INTO workspace_owners (workspace_id, owner_user_id, updated_at) SELECT ?, ?, ? WHERE EXISTS (${created})`).bind(id, owner, now, id),
    env.DB.prepare(`UPDATE standalone_invites SET used_workspace_id = ? WHERE code_hash = ? AND used_by = ? AND used_at = ? AND EXISTS (${created})`).bind(id, hash ?? '', owner, now, id),
  ]);
  if ((res[1]?.meta.changes ?? 0) > 0) {
    console.log(JSON.stringify({ audit: 'workspace_created', workspaceId: id, ownerUserId: owner, kind: 'standalone', invite: hash !== null }));
    return { status: 'created', id };
  }
  const owns = await env.DB.prepare(OWNS).bind(owner).first();
  return owns ? { status: 'already_owns' } : { status: 'invite_invalid' };
}

/** Daily cron: the creation-attempt log (rate-limit input) keeps 2 days. Best-effort. */
export async function pruneWorkspaceCreations(env: Pick<Env, 'DB'>, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM workspace_creations WHERE at < ?').bind(now - 2 * 86_400_000).run();
    await env.DB.prepare('DELETE FROM invite_attempts WHERE at < ?').bind(now - 2 * 86_400_000).run(); // the invite caps look back one day
    await env.DB.prepare("DELETE FROM workspace_invitations WHERE status <> 'pending' AND decided_at < ?").bind(now - 30 * 86_400_000).run();
    await env.DB.prepare("DELETE FROM workspace_invitations WHERE status = 'pending' AND expires_at < ?").bind(now - 30 * 86_400_000).run();
  } catch { /* best-effort */ }
}
