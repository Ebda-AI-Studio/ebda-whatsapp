/**
 * Deferred work for one workspace. A DO has a single alarm, so every delayed thing (nightly backup, owed R2 deletes,
 * throttled sends, later campaign steps) is a row in scheduled_tasks and the alarm is always armed for the earliest one.
 */
export type TaskKind = 'backup' | 'r2_drain' | 'send_release' | 'campaign_step' | 'media_fetch';
/** One pending row at most: scheduling again keeps the earlier due time. */
const SINGLETONS: ReadonlySet<TaskKind> = new Set(['backup', 'r2_drain']);
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

export function earliestDue(sql: SqlStorage): number | null {
  return sql.exec<{ d: number | null }>('SELECT min(due_at) AS d FROM scheduled_tasks').one().d;
}

export function dueTasks(sql: SqlStorage, now: number, limit: number): DueTask[] {
  return sql.exec<DueTask>('SELECT id, kind, due_at, payload, attempts FROM scheduled_tasks WHERE due_at <= ? ORDER BY due_at, id LIMIT ?', now, limit).toArray();
}
