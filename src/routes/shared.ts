import type { Context } from 'hono';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import type { WorkspaceDO } from '../core/workspace-do';
import type { ApiError } from '../core/api/contract';

export type ApiEnv = { Bindings: Env; Variables: AuthVars };
export type ApiContext = Context<ApiEnv>;

const KNOWN_TTL_MS = 60_000;
const known = new Map<string, number>();

/**
 * The DO for `:storeId`, or null when no such workspace is registered (a DO is never touched for an unknown id).
 * Only positive answers are cached, briefly: a workspace id is the store id and is never reassigned.
 */
export async function workspaceStub(c: ApiContext): Promise<DurableObjectStub<WorkspaceDO> | null> {
  const storeId = c.req.param('storeId')!;
  const now = Date.now();
  if ((known.get(storeId) ?? 0) <= now) {
    const row = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first();
    if (!row) return null;
    known.set(storeId, now + KNOWN_TTL_MS);
  }
  return c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId));
}

export function apiError(c: ApiContext, status: 400 | 401 | 403 | 404 | 409 | 411 | 413 | 415 | 429 | 503, error: ApiError['error'], message?: string): Response {
  return c.json({ error, ...(message ? { message } : {}) }, status);
}

/** Parses a positive integer route param; null when it is anything else. */
export function intParam(c: ApiContext, name: string): number | null {
  const n = Number(c.req.param(name));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The workspace's active WhatsApp number (the sender for API sends). */
export async function activeNumber(c: ApiContext): Promise<{ phoneNumberId: string; wabaId: string } | null> {
  const row = await c.env.DB.prepare("SELECT phone_number_id, waba_id FROM phone_numbers WHERE workspace_id = ? AND status = 'active' ORDER BY rowid LIMIT 1")
    .bind(c.req.param('storeId')!)
    .first<{ phone_number_id: string; waba_id: string }>();
  return row ? { phoneNumberId: row.phone_number_id, wabaId: row.waba_id } : null;
}
