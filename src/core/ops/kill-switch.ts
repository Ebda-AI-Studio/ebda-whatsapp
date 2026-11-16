import type { Env } from '../../env';
import { syncSuspendedMirror } from './suspension-mirror';
import { isEvicted, leaveShared } from '../shared/shared-number';
import { LAST_REASON_ID, REASON_PLACEHOLDER, reasonSql, reasonStmt } from '../audit-reason';

/**
 * The operator kill switch (W2-OPS). Every action takes an actor (the super admin) and a reason, writes ONE append-only `operator_actions` row
 * BEFORE it acts (so an action that half-fails is still on record), and writes both copies of the state it changes: D1 (what the Worker checks
 * first) and the workspace's own copy (what its Durable Object checks for the sends that never pass the Worker). Suspend writes D1 first, then the
 * workspace (the Worker blocks at once); unsuspend clears the workspace first, then D1 (a failure leaves it suspended, the safe side).
 */
export type Action = 'suspend' | 'unsuspend' | 'pause_campaigns' | 'evict_shared' | 'readmit_shared' | 'revoke_integrations' | 'restore_integrations';
/** `partial`: the D1 half was written (the Worker already refuses writes) but the workspace's own copy could not be reached; the same call again finishes it. */
export type Result<T = Record<string, never>> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'partial' };

const stub = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
async function known(env: Env, ws: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(ws).first());
}
/** The operator's reason goes to `audit_reasons`; the immutable row carries `reason_id` and the constant in the NOT NULL legacy column (AUDIT-REASONS-1). */
function audit(env: Env, a: { actor: string; action: Action; workspaceId: string; reason: string; now: number }): D1PreparedStatement[] {
  return [
    reasonStmt(env, { at: a.now, workspaceId: a.workspaceId, actor: a.actor, action: `operator.${a.action}`, reason: a.reason }),
    env.DB.prepare(`INSERT INTO operator_actions (at, actor, action, workspace_id, reason, reason_id) VALUES (?, ?, ?, ?, ?, ${LAST_REASON_ID})`).bind(a.now, a.actor, a.action, a.workspaceId, REASON_PLACEHOLDER),
  ];
}
/** Counts and ids only, never a phone number or a message. */
const note = (action: Action | 'suspend_partial', ws: string, actor: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ audit: `operator_${action}`, workspace: ws, actor, ...extra }));

export async function suspendWorkspace(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result<{ paused: number }>> {
  const ws = await env.DB.prepare('SELECT suspended_at, suspended_reason FROM workspaces WHERE id = ?').bind(a.workspaceId).first<{ suspended_at: number | null; suspended_reason: string | null }>();
  if (!ws) return { ok: false, reason: 'not_found' };
  // The audit row and the operator's reason are written whenever the OPERATOR flag is not already on in the workspace (a wallet debt or Store hold in D1 does not make
  // this a retry). A retry after a partial failure (D1 written with this reason, workspace copy not) finishes the job without a second audit row or a moved timestamp.
  const before = await (async () => stub(env, a.workspaceId).suspensionState())().catch(() => null); // an unreachable workspace copy: the D1 half is still written first (the Worker blocks at once)
  if (before?.operator == null && !(ws.suspended_at !== null && ws.suspended_reason === a.reason)) {
    await env.DB.batch([
      env.DB.prepare('UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = ? WHERE id = ?').bind(now, a.reason, a.workspaceId),
      ...audit(env, { ...a, action: 'suspend', now }),
    ]);
  }
  try {
    const { paused } = await stub(env, a.workspaceId).setSuspended(true, a.reason, now);
    await syncSuspendedMirror(env.DB, a.workspaceId, await stub(env, a.workspaceId).suspensionState(), now);
    note('suspend', a.workspaceId, a.actor, { paused });
    return { ok: true, value: { paused } };
  } catch {
    note('suspend_partial', a.workspaceId, a.actor);
    return { ok: false, reason: 'partial' };
  }
}

export async function unsuspendWorkspace(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch(audit(env, { ...a, action: 'unsuspend', now }));
  await stub(env, a.workspaceId).setSuspended(false, a.reason, now);
  // The operator lifts only the operator flag: a Store hold or a wallet debt hold keeps the workspace suspended (in the workspace and in D1) until it clears itself.
  await syncSuspendedMirror(env.DB, a.workspaceId, await stub(env, a.workspaceId).suspensionState(), now);
  note('unsuspend', a.workspaceId, a.actor);
  return { ok: true, value: {} };
}

export async function pauseAllCampaigns(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result<{ paused: number }>> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch(audit(env, { ...a, action: 'pause_campaigns', now }));
  const paused = await stub(env, a.workspaceId).pauseCampaignsOn(null, 'operator_paused', now);
  note('pause_campaigns', a.workspaceId, a.actor, { paused });
  return { ok: true, value: { paused } };
}

export async function evictFromSharedNumber(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch(audit(env, { ...a, action: 'evict_shared', now }));
  await leaveShared(env, a.workspaceId);
  note('evict_shared', a.workspaceId, a.actor);
  return { ok: true, value: {} };
}

export async function readmitToSharedNumber(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch(audit(env, { ...a, action: 'readmit_shared', now }));
  note('readmit_shared', a.workspaceId, a.actor);
  return { ok: true, value: {} };
}

/** From the next request on EVERY integrator token of the store is refused until `restoreIntegrations` (middleware reads D1 each time: no cache to age out). */
export async function revokeIntegrations(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch([
    env.DB.prepare('UPDATE workspaces SET integrations_revoked_at = ? WHERE id = ?').bind(now, a.workspaceId),
    ...audit(env, { ...a, action: 'revoke_integrations', now }),
  ]);
  note('revoke_integrations', a.workspaceId, a.actor);
  return { ok: true, value: {} };
}

export async function restoreIntegrations(env: Env, a: { actor: string; workspaceId: string; reason: string }, now = Date.now()): Promise<Result> {
  if (!(await known(env, a.workspaceId))) return { ok: false, reason: 'not_found' };
  await env.DB.batch([
    env.DB.prepare('UPDATE workspaces SET integrations_revoked_at = NULL WHERE id = ?').bind(a.workspaceId),
    ...audit(env, { ...a, action: 'restore_integrations', now }),
  ]);
  note('restore_integrations', a.workspaceId, a.actor);
  return { ok: true, value: {} };
}

export type WorkspaceOpsStatus = {
  suspended: boolean; suspendedReason: string | null; integrationsRevokedAt: number | null; evicted: boolean;
  numbers: { phoneNumberId: string; health: string; healthReason: string | null; healthAt: number | null }[];
  sharedNumber: { phoneNumberId: string; health: string; healthReason: string | null; healthAt: number | null } | null;
  recentActions: { at: number; actor: string; action: string; reason: string }[];
};
/** What the operator console shows for one workspace and for the platform number. */
export async function opsStatus(env: Env, workspaceId: string): Promise<WorkspaceOpsStatus | null> {
  const ws = await env.DB.prepare('SELECT suspended_at, suspended_reason, integrations_revoked_at FROM workspaces WHERE id = ?').bind(workspaceId).first<{ suspended_at: number | null; suspended_reason: string | null; integrations_revoked_at: number | null }>();
  if (!ws) return null;
  const numbers = await env.DB.prepare("SELECT phone_number_id, health_state, health_reason, health_at FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid").bind(workspaceId).all<{ phone_number_id: string; health_state: string; health_reason: string | null; health_at: number | null }>();
  const shared = await env.DB.prepare('SELECT phone_number_id, health_state, health_reason, health_at FROM shared_numbers ORDER BY created_at, rowid LIMIT 1').first<{ phone_number_id: string; health_state: string; health_reason: string | null; health_at: number | null }>();
  const recent = await env.DB.prepare(`SELECT o.at, o.actor, o.action, coalesce(${reasonSql('o', 'r')}, '') AS reason FROM operator_actions o LEFT JOIN audit_reasons r ON r.id = o.reason_id WHERE o.workspace_id = ? ORDER BY o.id DESC LIMIT 20`).bind(workspaceId).all<{ at: number; actor: string; action: string; reason: string }>();
  return {
    suspended: ws.suspended_at !== null, suspendedReason: ws.suspended_reason, integrationsRevokedAt: ws.integrations_revoked_at, evicted: await isEvicted(env, workspaceId),
    numbers: numbers.results.map((n) => ({ phoneNumberId: n.phone_number_id, health: n.health_state, healthReason: n.health_reason, healthAt: n.health_at })),
    sharedNumber: shared ? { phoneNumberId: shared.phone_number_id, health: shared.health_state, healthReason: shared.health_reason, healthAt: shared.health_at } : null,
    recentActions: recent.results,
  };
}
