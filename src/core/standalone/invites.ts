/**
 * Single-use operator invite codes for standalone workspaces (Ruling CHAT-SA-3). The plain code is shown to the operator ONCE and is never stored or logged:
 * D1 holds only a keyed hash. 12 Crockford base32 characters (60 bits), shown as XXXX-XXXX-XXXX, valid for at most 30 days.
 */
import type { Env } from '../../env';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const DAY_MS = 86_400_000;
export const INVITE_MAX_DAYS = 30;
export const INVITE_DEFAULT_DAYS = 14;

/** `STANDALONE_WORKSPACES`: off (default, also for any unknown value: fail closed) | invite | open. */
export type StandaloneMode = 'off' | 'invite' | 'open';
export const standaloneMode = (env: Pick<Env, 'STANDALONE_WORKSPACES'>): StandaloneMode => (env.STANDALONE_WORKSPACES === 'invite' || env.STANDALONE_WORKSPACES === 'open' ? env.STANDALONE_WORKSPACES : 'off');

/** What a person may type: case, dashes and spaces ignored, and the Crockford look-alikes (I L -> 1, O -> 0) accepted. Null when it cannot be a code. */
export function normaliseInviteCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(c) ? c : null;
}

/** 12 characters from a CSPRNG (256 is a multiple of 32, so the modulo is unbiased), grouped for reading aloud. */
export function mintInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const c = Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

/** Keyed hash (HKDF from ERASURE_HMAC_KEY, its own `info`), 32 hex characters. Null without the key: no key, no invites (fail closed). */
export async function inviteHash(env: Pick<Env, 'ERASURE_HMAC_KEY'>, code: string): Promise<string | null> {
  const secret = env.ERASURE_HMAC_KEY;
  const norm = normaliseInviteCode(code);
  if (!secret || !norm) return null;
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('standalone-invite/v1') }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(norm))).slice(0, 16);
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type InviteRow = { codeHash: string; createdBy: string; createdAt: number; expiresAt: number; usedAt: number | null; usedBy: string | null; usedWorkspaceId: string | null; revokedAt: number | null; note: string | null };

/** Mints one code. Returns the plain code (the only time it exists) and its hash, or null when there is no key or D1 failed. */
export async function mintInvite(env: Env, a: { actor: string; note: string | null; days: number }, now = Date.now()): Promise<{ code: string; codeHash: string; expiresAt: number } | null> {
  const code = mintInviteCode();
  const codeHash = await inviteHash(env, code);
  if (!codeHash) return null;
  const expiresAt = now + Math.min(Math.max(a.days, 1), INVITE_MAX_DAYS) * DAY_MS;
  try {
    await env.DB.prepare('INSERT INTO standalone_invites (code_hash, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?)').bind(codeHash, a.actor, now, expiresAt, a.note).run();
  } catch {
    return null;
  }
  return { code, codeHash, expiresAt };
}

export async function listInvites(env: Env, limit = 100): Promise<InviteRow[]> {
  const { results } = await env.DB.prepare('SELECT code_hash, created_by, created_at, expires_at, used_at, used_by, used_workspace_id, revoked_at, note FROM standalone_invites ORDER BY created_at DESC, code_hash LIMIT ?')
    .bind(Math.min(limit, 200)).all<{ code_hash: string; created_by: string; created_at: number; expires_at: number; used_at: number | null; used_by: string | null; used_workspace_id: string | null; revoked_at: number | null; note: string | null }>();
  return results.map((r) => ({ codeHash: r.code_hash, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by, usedWorkspaceId: r.used_workspace_id, revokedAt: r.revoked_at, note: r.note }));
}

/** Revokes an unused, unrevoked code. False when there was nothing to revoke. */
export async function revokeInvite(env: Env, codeHash: string, now = Date.now()): Promise<boolean> {
  const r = await env.DB.prepare('UPDATE standalone_invites SET revoked_at = ? WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL').bind(now, codeHash).run();
  return (r.meta.changes ?? 0) > 0;
}
