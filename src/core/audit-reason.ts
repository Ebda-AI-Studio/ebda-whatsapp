import type { Env } from '../env';

/**
 * AUDIT-REASONS-1 (docs/erasure-and-audit.md). The append-only tables (audit_log, offboarding_log, operator_actions, billing_audit, instapay_releases, pricing_settings,
 * workspace_pricing_overrides) hold NO free text. What a person typed goes to the deletable `audit_reasons` and the immutable row carries `reason_id`. Rules every writer follows:
 *  - the reason row is inserted IMMEDIATELY before the immutable row, in the same batch, and the immutable row takes `last_insert_rowid()`;
 *  - the old `reason` column is never written with text: `REASON_PLACEHOLDER` where it is NOT NULL, NULL otherwise; a structured key (an order id) goes to `billing_audit.ref`;
 *  - `before_json` / `after_json` never carry text: `stripText` drops the free-text keys.
 * test/guards.test.ts scans every INSERT into these tables for a free-text column.
 */
export const REASON_PLACEHOLDER = 'see reason_id';
export const PLATFORM_WORKSPACE = '_platform';
export const LAST_REASON_ID = 'last_insert_rowid()';

export function reasonStmt(env: Env, a: { at: number; workspaceId?: string | null; actor: string; action: string; reason: string }): D1PreparedStatement {
  return env.DB.prepare('INSERT INTO audit_reasons (at, workspace_id, actor, action, reason) VALUES (?, ?, ?, ?, ?)').bind(a.at, a.workspaceId ?? PLATFORM_WORKSPACE, a.actor, a.action.slice(0, 200), a.reason.slice(0, 500));
}

const TEXT_KEY = /^(reason|note|notes|text|message|body|comment|caption)$/i;
/** Drops free-text keys (recursively) from a value that is about to be stored as JSON in an immutable row. */
export function stripText(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripText);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !TEXT_KEY.test(k)).map(([k, x]) => [k, stripText(x)]));
  return v;
}
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(stripText(v)));

/** The statements for one billing_audit row (unconditional): the reason (if any) and the row. Spread them into a batch, or `await env.DB.batch(...)`. */
export function billingAuditStmts(env: Env, a: { at: number; actor: string; action: string; workspaceId?: string | null; before?: unknown; after?: unknown; reason?: string | null; ref?: string | null }): D1PreparedStatement[] {
  const text = a.reason?.trim() || null;
  return [
    ...(text ? [reasonStmt(env, { at: a.at, workspaceId: a.workspaceId ?? null, actor: a.actor, action: `billing.${a.action}`, reason: text })] : []),
    env.DB.prepare(`INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref, reason_id) VALUES (?, ?, ?, ?, ?, ?, ?, ${text ? LAST_REASON_ID : 'NULL'})`)
      .bind(a.at, a.actor, a.action, a.workspaceId ?? null, json(a.before), json(a.after), a.ref ?? null),
  ];
}
export const billingAudit = async (env: Env, a: Parameters<typeof billingAuditStmts>[1]): Promise<void> => { await env.DB.batch(billingAuditStmts(env, a)); };

/** `coalesce(joined reason, legacy text)`: rows written before AUDIT-REASONS-1 keep their text; new rows read it through the join (null once the workspace is deleted). */
export const reasonSql = (table: string, join: string): string => `coalesce(${join}.reason, nullif(${table}.reason, '${REASON_PLACEHOLDER}'))`;
