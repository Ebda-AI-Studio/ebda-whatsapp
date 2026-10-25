import { env, runInDurableObject } from 'cloudflare:test';

export async function seedNumber(phoneNumberId: string, workspaceId: string, status: 'active' | 'disconnected' = 'active', wabaId = 'waba-1', displayPhone: string | null = null): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(workspaceId, workspaceId, Date.now()),
    // Idempotent: seeding an already-seeded number is a no-op, so callers never need to swallow errors (a swallowed D1 failure left the
    // number unregistered and its funding unknown, which only showed on a slow CI runner).
    env.DB.prepare('INSERT OR IGNORE INTO phone_numbers (phone_number_id, waba_id, workspace_id, status, display_phone) VALUES (?, ?, ?, ?, ?)').bind(phoneNumberId, wabaId, workspaceId, status, displayPhone),
    // what connecting an own number does (the connect hook records the funding explicitly)
    env.DB.prepare("INSERT OR IGNORE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'merchant_card', 0)").bind(phoneNumberId),
  ]);
  await seedPlan(workspaceId);
}

/**
 * A workspace the control plane has pushed a plan to. Marketing is blocked without one (fail closed), so every test workspace that is
 * set up with a number gets an active baseline plan at version 0; a test that applies its own entitlement (version >= 1) replaces it.
 */
export async function seedPlan(workspaceId: string): Promise<void> {
  await runInDurableObject(workspace(workspaceId), (_i, state) => {
    state.storage.sql.exec("INSERT OR IGNORE INTO entitlements (id, version, package_id, status, period_start, period_end, ai_credits, cancelled_at, updated_at) VALUES (1, 0, 'test-plan', 'active', 0, 8640000000000000, 0, NULL, 0)");
  });
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

/**
 * Makes `phoneNumberId` this workspace's registered number (moving it from whichever test used it before) with merchant-card funding,
 * the way connecting a number does. Sends from a number the control plane has not registered are refused (funding must be known).
 */
export async function own(workspaceId: string, phoneNumberId = 'pn-x', funding: 'merchant_card' | 'platform_line' = 'merchant_card'): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').bind(workspaceId, workspaceId, Date.now()),
    env.DB.prepare('DELETE FROM phone_numbers WHERE phone_number_id = ?').bind(phoneNumberId),
    env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status) VALUES (?, 'waba-own', ?, 'active')").bind(phoneNumberId, workspaceId),
    env.DB.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, 0)').bind(phoneNumberId, funding),
  ]);
  await seedPlan(workspaceId);
  await workspace(workspaceId).refreshPricing();
}
