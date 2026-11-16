import type { SuspensionState } from '../numbers/health';

/** The only D1 reasons the mirror owns (it may set, replace and clear these). Any other reason (an operator's, `offboarding`) is written and cleared only by its own explicit path. */
const OWNED = "('store_suspended', 'store_deleted', 'wallet_debt')";

/**
 * D1 `workspaces.suspended_at/suspended_reason` (what the Worker checks first) is DERIVED from the workspace's own flags, by this ONE helper, used by every automatic writer
 * (the Store hold mirror, the wallet debt guard, the operator suspend's final sync). The reason is the operator's, else the Store tag, else `wallet_debt`; with no flag on the
 * row is cleared. SAFETY: it only ever changes a row that is empty or holds a reason it owns, so a merchant-triggered sync (paying a debt, a Store reactivation) can never lift
 * or overwrite an operator suspension whose workspace half is missing (kill-switch `partial`) or offboarding's D1-only `offboarding`. `operatorLift` is for the operator's own explicit
 * unsuspend only: it replaces whatever reason is there with what the remaining flags say.
 */
export async function syncSuspendedMirror(db: D1Database, workspaceId: string, state: SuspensionState, now: number, opts: { operatorLift?: boolean } = {}): Promise<void> {
  const reason = state.operator ?? state.store ?? (state.debt ? 'wallet_debt' : null);
  const guard = opts.operatorLift ? '' : ` AND (suspended_reason IS NULL OR suspended_reason IN ${OWNED})`;
  if (reason) await db.prepare(`UPDATE workspaces SET suspended_at = coalesce(suspended_at, ?), suspended_reason = ? WHERE id = ?${guard}`).bind(now, reason, workspaceId).run();
  else await db.prepare(`UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?${opts.operatorLift ? '' : ` AND suspended_reason IN ${OWNED}`}`).bind(workspaceId).run();
}
