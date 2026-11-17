/**
 * The explicit "yes" for a merchant money action (spec section 4, rule 4). Two calls, never one:
 *  1. `issueConfirmation` runs on the PREVIEW call: the server stores the SHA-256 of a random token and of the exact payload the merchant was shown, and hands the token back once.
 *  2. `consumeConfirmation` runs on the ACTION call: the token must be the one issued to this workspace + user + action, unexpired, unused, and the payload recomputed NOW must hash to
 *     the same value. One conditional UPDATE marks it used, so a replay or a double click finds it used and nothing happens twice.
 * A payload that changed between the two (a refund quote that moved because a month began, a price that changed) is `mismatch`: the screen previews again.
 * Only the hash of the token is stored; the workspace and user come from the session, never from the body.
 */
import type { Env } from '../../env';

export type ConfirmAction = 'number_funding' | 'yearly_refund_request' | 'credit_pack';
export const CONFIRM_TTL_MS = 15 * 60_000;
const KEEP_EXPIRED_MS = 86_400_000;

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

/** Flat payloads only (strings, integers, booleans): keys sorted, so the same facts always hash the same. */
export const payloadHash = (payload: Record<string, string | number | boolean>): Promise<string> =>
  sha256(JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]])));

export type Issued = { confirmId: string; token: string; expiresAt: number };

export async function issueConfirmation(env: Env, a: { workspaceId: string; userId: string; action: ConfirmAction; payload: Record<string, string | number | boolean> }, now = Date.now()): Promise<Issued> {
  const confirmId = crypto.randomUUID();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const expiresAt = now + CONFIRM_TTL_MS;
  await env.DB.batch([
    // One open confirmation per workspace + user + action: a new preview replaces the old one, so rows stay bounded and a stale card cannot be confirmed.
    env.DB.prepare('DELETE FROM money_confirmations WHERE (workspace_id = ? AND user_id = ? AND action = ? AND used_at IS NULL) OR expires_at < ?').bind(a.workspaceId, a.userId, a.action, now - KEEP_EXPIRED_MS),
    env.DB.prepare('INSERT INTO money_confirmations (id, workspace_id, user_id, action, payload_hash, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(confirmId, a.workspaceId, a.userId, a.action, await payloadHash(a.payload), await sha256(token), expiresAt, now),
  ]);
  return { confirmId, token, expiresAt };
}

export type Consumed = 'ok' | 'missing' | 'used' | 'expired' | 'mismatch';

export async function consumeConfirmation(env: Env, a: { workspaceId: string; userId: string; action: ConfirmAction; confirmId: string; token: string; payload: Record<string, string | number | boolean> }, now = Date.now()): Promise<Consumed> {
  const row = await env.DB.prepare('SELECT payload_hash, token_hash, expires_at, used_at FROM money_confirmations WHERE id = ? AND workspace_id = ? AND user_id = ? AND action = ?')
    .bind(a.confirmId, a.workspaceId, a.userId, a.action).first<{ payload_hash: string; token_hash: string; expires_at: number; used_at: number | null }>();
  if (!row || row.token_hash !== (await sha256(a.token))) return 'missing'; // a wrong token is indistinguishable from an unknown id
  if (row.used_at !== null) return 'used';
  if (row.expires_at <= now) return 'expired';
  if (row.payload_hash !== (await payloadHash(a.payload))) return 'mismatch';
  const claim = await env.DB.prepare('UPDATE money_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?').bind(now, a.confirmId, now).run();
  return claim.meta.changes === 1 ? 'ok' : 'used';
}
