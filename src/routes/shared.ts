import type { Context } from 'hono';
import type { Env } from '../env';
import type { AuthVars } from '../core/identity/middleware';
import type { WorkspaceDO } from '../core/workspace-do';
import type { ApiError } from '../core/api/contract';
import { senderNumberFor } from '../core/shared/shared-number';
import { graphTokenFor, TokenUnavailable } from '../core/numbers/token';

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

export function apiError(c: ApiContext, status: 400 | 401 | 402 | 403 | 404 | 409 | 411 | 413 | 415 | 429 | 503, error: ApiError['error'], message?: string): Response {
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

/** Where this request's workspace sends from: its own active number, else the shared platform number while it is a member (switch on). */
export async function senderNumber(c: ApiContext): Promise<{ phoneNumberId: string; wabaId: string; shared: boolean } | null> {
  return senderNumberFor(c.env, c.req.param('storeId')!);
}

/** The Graph token for a WABA or number of this request's workspace, or null when an own number's credential is unusable (answer 503 token_unavailable). */
export async function bizToken(c: ApiContext, ref: { wabaId: string } | { phoneNumberId: string }): Promise<string | null> {
  try {
    return await graphTokenFor(c.env, ref);
  } catch (err) {
    if (err instanceof TokenUnavailable) return null;
    throw err;
  }
}

/** Owner powers on a store: its owner or a platform super admin. A positive allow-list on purpose: a role added later (an integration
 * principal, say) gets nothing here unless it is named. Never write it as "anything but staff". */
export const managesStore = (c: ApiContext): boolean => {
  const r = c.get('storeRole');
  return r === 'owner' || r === 'super_admin';
};

/** WA-NOFREE-1: 403 plan_required unless the workspace has a package in good standing (or inside its bounded past_due grace). Null = go on. */
export async function planRequired(c: ApiContext, ws: { serviceOk(): Promise<boolean> }): Promise<Response | null> {
  return (await ws.serviceOk()) ? null : apiError(c, 403, 'plan_required');
}
