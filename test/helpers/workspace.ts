import { env, runInDurableObject } from 'cloudflare:test';

export async function seedNumber(phoneNumberId: string, workspaceId: string, status: 'active' | 'disconnected' = 'active'): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(workspaceId, workspaceId, Date.now()),
    env.DB.prepare('INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status) VALUES (?, ?, ?, ?)').bind(phoneNumberId, 'waba-1', workspaceId, status),
  ]);
}

export function workspace(workspaceId: string) {
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
}

export async function rows<T = Record<string, unknown>>(workspaceId: string, sql: string, ...params: unknown[]): Promise<T[]> {
  return runInDurableObject(workspace(workspaceId), (_i, state) => state.storage.sql.exec(sql, ...params).toArray() as T[]);
}
