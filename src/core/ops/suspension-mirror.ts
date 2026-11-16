import type { SuspensionState } from '../numbers/health';

/**
 * D1 `workspaces.suspended_at/suspended_reason` (what the Worker checks first) is DERIVED from the workspace's own flags, by this ONE helper, used by every writer
 * (operator suspend / unsuspend, the Store hold mirror, the wallet debt guard). The reason is the operator's, else the Store tag, else `wallet_debt`; with no flag on
 * both columns are NULL. So each reason clears independently and a D1 reason can never outlive the flag it mirrors. Idempotent: callers may run it any number of times.
 */
export async function syncSuspendedMirror(db: D1Database, workspaceId: string, state: SuspensionState, now: number): Promise<void> {
  const reason = state.operator ?? state.store ?? (state.debt ? 'wallet_debt' : null);
  if (reason) await db.prepare('UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = ? WHERE id = ?').bind(now, reason, workspaceId).run();
  else await db.prepare('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?').bind(workspaceId).run();
}
