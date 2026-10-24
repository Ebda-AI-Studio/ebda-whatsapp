import { env, runInDurableObject } from 'cloudflare:test';

export async function seedNumber(phoneNumberId: string, workspaceId: string, status: 'active' | 'disconnected' = 'active', wabaId = 'waba-1', displayPhone: string | null = null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(workspaceId, workspaceId, Date.now()),
    env.DB.prepare('INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, display_phone) VALUES (?, ?, ?, ?, ?)').bind(phoneNumberId, wabaId, workspaceId, status, displayPhone),
  ]);
}

export function workspace(workspaceId: string) {
  return env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(workspaceId));
}

export async function rows<T = Record<string, unknown>>(workspaceId: string, sql: string, ...params: unknown[]): Promise<T[]> {
  return runInDurableObject(workspace(workspaceId), (_i, state) => state.storage.sql.exec(sql, ...params).toArray() as T[]);
}

/** Runs a write (or any statement) inside the workspace's DO. */
export async function exec(workspaceId: string, sql: string, ...params: unknown[]): Promise<void> {
  await runInDurableObject(workspace(workspaceId), (_i, state) => {
    state.storage.sql.exec(sql, ...(params as SqlStorageValue[]));
  });
}

/** Ingests one inbound text so the contact has an open 24 h window; returns the conversation id. */
export async function openChat(workspaceId: string, waId = '201001234567', opts: { ts?: number; text?: string; wamid?: string } = {}): Promise<number> {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  await workspace(workspaceId).ingest({
    phoneNumberId: 'pn-x',
    inbound: [{ wamid: opts.wamid ?? `wamid.open.${workspaceId}.${waId}.${ts}`, from: waId, ts, type: 'text', text: opts.text ?? 'مرحبا' }],
    statuses: [],
    receivedAt: Date.now(),
  });
  const r = await rows<{ id: number }>(workspaceId, 'SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', waId);
  return r[0]!.id;
}
