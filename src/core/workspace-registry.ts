/**
 * Ruling CHAT-ENABLE-1: a Chat workspace exists only because a store OWNER chose to connect Chat. This is the ONE place that creates the registry row
 * (`workspaces`, the row every store route resolves the store through) and records the owner; every consent path goes through it, nothing creates a row on a visit.
 *
 * What enabling starts: the registry row and the owner row, nothing else. No charge (money moves only through the plan / wallet flows the owner starts), no trial clock;
 * the only clock is the new-workspace campaign cap (campaigns.md: first 14 days after the workspace's Durable Object first runs). The plan comes from the Store's own plan event.
 */
import type { Env } from '../env';
import { recordWorkspaceOwner } from './campaigns/new-cap';

const NAME_MAX = 100;

export type EnsureResult = 'created' | 'exists';

/**
 * Idempotent. `name` is display text from the Store (never trusted for anything else); an existing row keeps its name. The owner row is refreshed on every call (the Store
 * confirmed this user as the owner right before). The caller has ALREADY verified the owner against the Store: this function trusts nothing it is not given and checks nothing it cannot.
 */
export async function ensureWorkspace(env: Pick<Env, 'DB'>, a: { storeId: string; ownerUserId: string; name: string | null }, now = Date.now()): Promise<EnsureResult> {
  const name = (a.name ?? '').trim().slice(0, NAME_MAX) || a.storeId;
  const r = await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(a.storeId, name, now).run();
  await recordWorkspaceOwner(env, a.storeId, a.ownerUserId, now);
  const created = (r.meta.changes ?? 0) > 0;
  if (created) console.log(JSON.stringify({ audit: 'workspace_enabled', storeId: a.storeId, ownerUserId: a.ownerUserId.slice(0, 120) }));
  return created ? 'created' : 'exists';
}
