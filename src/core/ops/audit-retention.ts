import type { Env } from '../../env';
import { billingAuditStmts } from '../audit-reason';

/**
 * Ruling AUDIT-RETENTION-1 (docs/erasure-and-audit.md). `audit_log` is append-only by trigger, so the only ways to change or remove a row are the two
 * procedures here. Both are ONE D1 batch (a single transaction): drop the two triggers, do the work, re-create the triggers. If any statement fails the whole
 * batch rolls back and the triggers are still there. Nothing else in the code base may drop an audit trigger.
 */
export const AUDIT_RETENTION_YEARS = 5;
const YEAR_MS = 365 * 86_400_000;

const TRIGGERS: { name: string; create: string }[] = [
  { name: 'audit_log_no_update', create: "CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END" },
  { name: 'audit_log_no_delete', create: "CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END" },
];

/** Wraps `work` between "drop the append-only triggers" and "put them back". Use only through the two functions below. */
function controlled(env: Env, work: D1PreparedStatement[]): D1PreparedStatement[] {
  return [
    ...TRIGGERS.map((t) => env.DB.prepare(`DROP TRIGGER ${t.name}`)),
    ...work,
    ...TRIGGERS.map((t) => env.DB.prepare(t.create)),
  ];
}

/** Offboarding: the merchant's own user ids (owner / staff rows of that workspace) become the pseudonym the money tables use. Operators and integration clients stay. */
export function pseudonymiseAuditActors(env: Env, workspaceId: string, pseudo: string): D1PreparedStatement[] {
  return controlled(env, [env.DB.prepare("UPDATE audit_log SET actor = ? WHERE workspace_id = ? AND actor_role IN ('owner', 'staff')").bind(pseudo, workspaceId)]);
}

/** Rows older than the retention are deleted, with the purge's own audit entry in the same batch. Run through `POST /operator/audit-log/purge`. */
export function purgeAuditStatements(env: Env, a: { actor: string; reason: string; now: number }): D1PreparedStatement[] {
  const cutoff = a.now - AUDIT_RETENTION_YEARS * YEAR_MS;
  return controlled(env, [
    ...billingAuditStmts(env, { at: a.now, actor: a.actor, action: 'audit_log_purged', after: { cutoff, retentionYears: AUDIT_RETENTION_YEARS }, reason: a.reason }),
    env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(cutoff),
  ]);
}

export async function purgeAuditLog(env: Env, a: { actor: string; reason: string }, now = Date.now()): Promise<{ purged: number; retentionYears: number; cutoff: number }> {
  const cutoff = now - AUDIT_RETENTION_YEARS * YEAR_MS;
  const res = await env.DB.batch(purgeAuditStatements(env, { ...a, now }));
  const purged = res[res.length - TRIGGERS.length - 1]?.meta.changes ?? 0; // the DELETE is the last statement before the triggers come back
  return { purged, retentionYears: AUDIT_RETENTION_YEARS, cutoff };
}
