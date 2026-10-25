/**
 * Ledger rows leave the workspace through an outbox written in the SAME transaction as the row, and are copied to D1 `ledger_mirror` by
 * a task. The copy is idempotent (primary key workspace + ledger + ref), so a drain that dies half way simply repeats. A nightly check
 * compares the two sums per workspace; any difference is an alert, never an automatic fix (the DO is the truth).
 */
import type { Env } from '../../env';

type Sql = DurableObjectStorage['sql'];
const BATCH = 50;
const MAX_BATCHES = 20;

type Pending = { ledger: 'wallet' | 'credit'; ref: string; row_json: string };

/** Copies pending outbox rows to D1; marks each drained only after D1 accepted its batch. Throws on a D1 failure (the task retries with backoff). */
export async function drainOutbox(env: Env, sql: Sql, workspaceId: string, now: number): Promise<{ drained: number; remaining: number }> {
  let drained = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = sql.exec<Pending>('SELECT ledger, ref, row_json FROM ledger_outbox WHERE drained_at IS NULL ORDER BY ledger, ref LIMIT ?', BATCH).toArray();
    if (!rows.length) break;
    await env.DB.batch(rows.map((r) => {
      const j = JSON.parse(r.row_json) as { at: number; kind: string; amount: number; balance_after: number };
      return env.DB.prepare('INSERT INTO ledger_mirror (workspace_id, ledger, ref, at, kind, amount, balance_after) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(workspaceId, r.ledger, r.ref, j.at, j.kind, j.amount, j.balance_after);
    }));
    for (const r of rows) sql.exec('UPDATE ledger_outbox SET drained_at = ? WHERE ledger = ? AND ref = ? AND drained_at IS NULL', now, r.ledger, r.ref);
    drained += rows.length;
  }
  const remaining = sql.exec<{ n: number }>('SELECT count(*) AS n FROM ledger_outbox WHERE drained_at IS NULL').one().n;
  return { drained, remaining };
}

export type MirrorCheck = { ledger: 'wallet' | 'credit'; doSum: number; d1Sum: number; doRows: number; d1Rows: number; equal: boolean };

/** DO sum vs D1 sum for both ledgers. Rows still waiting in the outbox are excluded from the DO side, so a check mid-drain is not a false alarm. */
export async function checkMirror(env: Env, sql: Sql, workspaceId: string): Promise<MirrorCheck[]> {
  const out: MirrorCheck[] = [];
  for (const [ledger, table, col] of [['wallet', 'wallet_ledger', 'amount_minor'], ['credit', 'credit_ledger', 'amount']] as const) {
    const mine = sql.exec<{ s: number; n: number }>(
      `SELECT coalesce(sum(${col}), 0) AS s, count(*) AS n FROM ${table} WHERE ref NOT IN (SELECT ref FROM ledger_outbox WHERE ledger = ? AND drained_at IS NULL)`, ledger,
    ).one();
    const theirs = await env.DB.prepare('SELECT coalesce(sum(amount), 0) AS s, count(*) AS n FROM ledger_mirror WHERE workspace_id = ? AND ledger = ?').bind(workspaceId, ledger).first<{ s: number; n: number }>();
    const d1Sum = theirs?.s ?? 0;
    const d1Rows = theirs?.n ?? 0;
    const equal = mine.s === d1Sum && mine.n === d1Rows;
    if (!equal) console.error(JSON.stringify({ alert: 'ledger_mirror_mismatch', workspace: workspaceId, ledger, doSum: mine.s, d1Sum, doRows: mine.n, d1Rows }));
    out.push({ ledger, doSum: mine.s, d1Sum, doRows: mine.n, d1Rows, equal });
  }
  return out;
}
