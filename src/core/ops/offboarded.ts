import type { Env } from '../../env';
import { alert } from '../observability';

/**
 * Money that reaches a workspace which is being or has been deleted (OFFBOARD-1, review items 1 and 2).
 *
 * After deletion the money records live under a pseudonym `del_<32 hex>`; a payment provider can still confirm a top-up or an order days later, and every
 * grant path would then call `WORKSPACE_DO.get(idFromName('del_...'))`: that creates an empty ghost workspace and credits it. These helpers are the one
 * gate in front of every credit/grant/charge: a refused one raises `credit_after_offboard` (P1), is recorded once in `billing_audit`, and is left for a
 * person to refund by hand (docs/runbooks/alerts.md). The Durable Object is never addressed for it.
 */
export const PSEUDONYM_RE = /^del_[0-9a-f]{32}$/;

/** A deletion that has been asked for and not cancelled: new purchases are refused (OFFBOARD-FREEZE-1). */
export async function frozenForOffboarding(env: Env, ws: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM offboarding WHERE workspace_id = ? AND state IN ('pending', 'running')").bind(ws).first());
}

/** Past the point of no return: the id is a pseudonym, the run finished, or the workspace's own storage is already wiped. */
export async function isOffboarded(env: Env, ws: string): Promise<boolean> {
  if (PSEUDONYM_RE.test(ws)) return true;
  const r = await env.DB.prepare('SELECT state, steps_done FROM offboarding WHERE workspace_id = ?').bind(ws).first<{ state: string; steps_done: string }>();
  return !!r && (r.state === 'done' || (r.state === 'running' && r.steps_done.split(',').includes('wipe_do')));
}

/** True = refuse (the caller must not touch the workspace). Records and alerts once per (workspace, what, ref). */
export async function refuseIfOffboarded(env: Env, ws: string, what: string, ref: string, now = Date.now()): Promise<boolean> {
  if (!(await isOffboarded(env, ws))) return false;
  try {
    const key = `${what}:${ref}`;
    const seen = await env.DB.prepare("SELECT 1 FROM billing_audit WHERE action = 'credit_after_offboard' AND workspace_id = ? AND reason = ? LIMIT 1").bind(ws, key).first();
    if (!seen) await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, 'system', 'credit_after_offboard', ?, NULL, NULL, ?)").bind(now, ws, key).run();
  } catch { /* the alert below still goes out */ }
  alert('credit_after_offboard', { severity: 'P1', workspace: ws, what, ref });
  return true;
}
