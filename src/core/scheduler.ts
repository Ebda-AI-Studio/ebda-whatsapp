/**
 * Deferred work for one workspace. A DO has a single alarm, so every delayed thing (nightly backup, owed R2 deletes,
 * throttled sends, later campaign steps) is a row in scheduled_tasks and the alarm is always armed for the earliest one.
 */
export type TaskKind = 'backup' | 'r2_drain' | 'send_release' | 'campaign_step' | 'media_fetch' | 'catalog_sync' | 'catalog_reconcile' | 'cod_no_reply' | 'cod_outcome_push' | 'bot_turn' | 'erased_order_notify' | 'kb_index' | 'catalog_embed' | 'subscription_expire' | 'wallet_wait' | 'wallet_sweep' | 'ledger_drain' | 'shared_number_trueup';
/** One pending row at most: scheduling again keeps the earlier due time. */
const SINGLETONS: ReadonlySet<TaskKind> = new Set(['backup', 'r2_drain', 'catalog_sync', 'catalog_reconcile', 'kb_index', 'catalog_embed', 'campaign_step', 'wallet_sweep', 'ledger_drain']);
export const DAILY_KINDS = ['backup', 'r2_drain'] as const;

export type DueTask = { id: number; kind: TaskKind; due_at: number; payload: string | null; attempts: number };

/** 30 s, 1 min, 2 min … capped at 1 h. `attempts` counts failures including the one just recorded. */
export const backoffMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.min(attempts - 1, 20), 3_600_000);

export function addTask(sql: SqlStorage, kind: TaskKind, dueAt: number, payload?: unknown): void {
  const body = payload === undefined ? null : JSON.stringify(payload);
  if (SINGLETONS.has(kind)) {
    const existing = sql.exec<{ id: number; due_at: number }>('SELECT id, due_at FROM scheduled_tasks WHERE kind = ? ORDER BY due_at LIMIT 1', kind).toArray()[0];
    if (existing) {
      if (dueAt < existing.due_at) sql.exec('UPDATE scheduled_tasks SET due_at = ? WHERE id = ?', dueAt, existing.id);
      return;
    }
  }
  sql.exec('INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES (?, ?, ?)', kind, dueAt, body);
}

/** A claimed task's lease: longer than any single task run (backup export, media download) is expected to take. */
export const TASK_LEASE_MS = 5 * 60_000;

/** Earliest moment any task can run: a leased task counts from its lease end, so the alarm never spins on it. */
export function earliestDue(sql: SqlStorage): number | null {
  return sql.exec<{ d: number | null }>('SELECT min(max(due_at, coalesce(lease_until, 0))) AS d FROM scheduled_tasks').one().d;
}

/**
 * Claims up to `limit` due, unleased tasks. Select and lease happen in one synchronous step (no await), so two runners
 * interleaving at an await can never claim the same row. Leases are measured on the real clock.
 */
export function claimDueTasks(sql: SqlStorage, now: number, limit: number, realNow = Date.now()): DueTask[] {
  const rows = sql.exec<DueTask>(
    'SELECT id, kind, due_at, payload, attempts FROM scheduled_tasks WHERE due_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY due_at, id LIMIT ?',
    now, realNow, limit,
  ).toArray();
  for (const r of rows) sql.exec('UPDATE scheduled_tasks SET lease_until = ? WHERE id = ?', realNow + TASK_LEASE_MS, r.id);
  return rows;
}
