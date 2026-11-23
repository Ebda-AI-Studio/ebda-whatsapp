/**
 * Ruling CHAT-SA-4: the team of a STANDALONE workspace lives here (D1 `workspace_members`), not in a Store. Owner + staff; a staff member works only while they hold a seat
 * (the Durable Object `seats` table, as for Store workspaces). Brand-neutral: the invitation mail copy lives in the accounts service (`inviteChatMember`).
 *
 * An invitation is not a membership (consent): the owner invites, the invitee ACCEPTS while signed in as the invited identity, and only then does a membership row + a seat exist.
 * Until then they have no access; the owner sees the first name and address the owner typed (never the invitee's accounts profile). A membership change is never-stale: the middleware
 * reads the row on every request, so a removal takes effect on the very next call and the seat is dropped in the same request.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { recordAudit } from './audit';
import type { StoreMember } from './store-bridge';
import { isStandaloneId } from './workspace-kind';

export const inviteRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: z.string().trim().min(1).max(100),
  language: z.enum(['ar', 'en']).default('ar'),
}).strict();
export type InviteRequest = z.infer<typeof inviteRequest>;

type Accounts = NonNullable<Env['ACCOUNTS']>;
type Row = { user_id: string; role: 'owner' | 'staff'; created_at: number };
const wsStub = (env: Pick<Env, 'WORKSPACE_DO'>, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));
const requireStandalone = (ws: string) => { if (!isStandaloneId(ws)) throw new Error('not_standalone'); };

export const INVITE_TTL_MS = 7 * 86_400_000;
/** The accounts mail cap is per ADDRESS only: without a cap here an owner could send branded mail to unlimited addresses. */
export const INVITE_CAP = { perWorkspaceDay: 20, perInviterDay: 30 } as const;
const DAY_MS = 86_400_000;
/** A workspace name goes into a mail subject: no line breaks or other control characters (header injection), no runs of space. */
export const mailSafeName = (name: string): string => name.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

/** The ACTIVE team from D1, names from accounts (one batched read). Only ACCEPTED members are looked up: a pending invitee's accounts profile is never read here. */
export async function listStandaloneMembers(env: Pick<Env, 'DB' | 'ACCOUNTS'>, ws: string): Promise<StoreMember[]> {
  requireStandalone(ws);
  const rows = (await env.DB.prepare("SELECT user_id, role, created_at FROM workspace_members WHERE workspace_id = ? AND status = 'active' ORDER BY role = 'owner' DESC, created_at, user_id LIMIT 200").bind(ws).all<Row>()).results ?? [];
  const names = new Map<string, string>();
  const accounts = env.ACCOUNTS;
  if (rows.length > 0 && typeof accounts?.getAccountsBrief === 'function') {
    try {
      for (const b of await accounts.getAccountsBrief(rows.map((r) => r.user_id).slice(0, 100))) names.set(b.id, `${b.firstName} ${b.lastName}`.trim() || b.email);
    } catch { /* names are display only */ }
  }
  return rows.map((r) => ({ userId: r.user_id, displayName: names.get(r.user_id) ?? r.user_id.slice(0, 8), role: r.role, addedAt: new Date(r.created_at).toISOString() }));
}

export type PendingInvitation = { userId: string; email: string; firstName: string; invitedAt: string; expiresAt: string };
/** What the OWNER typed, nothing from accounts. Unexpired pending invitations only. */
export async function listPendingInvitations(env: Pick<Env, 'DB'>, ws: string, now = Date.now()): Promise<PendingInvitation[]> {
  requireStandalone(ws);
  const rows = (await env.DB.prepare("SELECT user_id, email, first_name, created_at, expires_at FROM workspace_invitations WHERE workspace_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at, user_id LIMIT 100").bind(ws, now).all<{ user_id: string; email: string; first_name: string; created_at: number; expires_at: number }>()).results ?? [];
  return rows.map((r) => ({ userId: r.user_id, email: r.email, firstName: r.first_name, invitedAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString() }));
}

export type InviteResult = { status: 'invite_sent' } | { status: 'seat_limit'; limit: number } | { status: 'unavailable' } | { status: 'rate_limited'; retryAfterS: number };

/**
 * Reserves one invite attempt against BOTH daily caps with ONE conditional INSERT (a D1 statement is atomic, so N parallel callers at cap-1 get exactly one reservation). Counted before the
 * accounts call, so failures use the allowance too. A write error THROWS (the caller answers 503): the cap fails closed, never open.
 */
export async function reserveInviteAttempt(env: Pick<Env, 'DB'>, ws: string, inviter: string, now: number): Promise<boolean> {
  const since = now - DAY_MS;
  const r = await env.DB.prepare(
    `INSERT INTO invite_attempts (workspace_id, inviter, at) SELECT ?1, ?2, ?3
     WHERE (SELECT count(*) FROM invite_attempts WHERE workspace_id = ?1 AND at > ?4) < ?5 AND (SELECT count(*) FROM invite_attempts WHERE inviter = ?2 AND at > ?4) < ?6`,
  ).bind(ws, inviter, now, since, INVITE_CAP.perWorkspaceDay, INVITE_CAP.perInviterDay).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Owner invites a staff member by email. Order: seat room (active staff + open invitations; no accounts call and no mail when the package is full), the atomic cap reservation, the
 * accounts RPC (creates or resolves the identity and mails it; the answer never says which), then ONE pending invitation row holding what the owner typed. No membership, no seat, no
 * access yet. A refused identity (inactive/erased), the owner's own address and an address that is already active staff are all answered like a success and write nothing.
 */
export async function inviteStandaloneMember(env: Pick<Env, 'DB' | 'ACCOUNTS' | 'WORKSPACE_DO'> & Partial<Env>, ws: string, ownerId: string, a: InviteRequest, now = Date.now()): Promise<InviteResult> {
  requireStandalone(ws);
  const { limit } = await wsStub(env, ws).seatSummary();
  const open = await env.DB.prepare(
    "SELECT (SELECT count(*) FROM workspace_members WHERE workspace_id = ?1 AND role = 'staff' AND status = 'active') + (SELECT count(*) FROM workspace_invitations WHERE workspace_id = ?1 AND status = 'pending' AND expires_at > ?2) AS n",
  ).bind(ws, now).first<{ n: number }>();
  if ((open?.n ?? 0) >= limit - 1) return { status: 'seat_limit', limit };
  const accounts = env.ACCOUNTS as Accounts | undefined;
  if (typeof accounts?.inviteChatMember !== 'function') return { status: 'unavailable' };
  if (!(await reserveInviteAttempt(env, ws, ownerId, now))) return { status: 'rate_limited', retryAfterS: 3600 };
  const name = mailSafeName((await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(ws).first<{ name: string }>())?.name ?? '');
  let userId: string;
  try {
    ({ userId } = await accounts.inviteChatMember({ email: a.email, firstName: a.firstName, language: a.language, workspaceName: name }));
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes('INVITE_REFUSED')) {
      console.warn(JSON.stringify({ warn: 'standalone_invite_refused', workspaceId: ws }));
      return { status: 'invite_sent' };
    }
    console.warn(JSON.stringify({ warn: 'standalone_invite_unavailable', workspaceId: ws }));
    return { status: 'unavailable' };
  }
  const existing = await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'").bind(ws, userId).first<{ role: string }>();
  if (existing) return { status: 'invite_sent' }; // the owner's own address, or someone already on the team: nothing to add, nothing to reveal
  await env.DB.prepare(
    `INSERT INTO workspace_invitations (workspace_id, user_id, email, first_name, invited_by, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET email = excluded.email, first_name = excluded.first_name, invited_by = excluded.invited_by, created_at = excluded.created_at, expires_at = excluded.expires_at, status = 'pending', decided_at = NULL`,
  ).bind(ws, userId, a.email, a.firstName, ownerId, now, now + INVITE_TTL_MS).run();
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'member.invited', targetType: 'member', targetId: userId }, now);
  return { status: 'invite_sent' };
}

/** Owner withdraws a pending invitation (the emailed link stops working). */
export async function revokeInvitation(env: Pick<Env, 'DB'> & Partial<Env>, ws: string, ownerId: string, userId: string, now = Date.now()): Promise<boolean> {
  requireStandalone(ws);
  const r = await env.DB.prepare("UPDATE workspace_invitations SET status = 'revoked', decided_at = ? WHERE workspace_id = ? AND user_id = ? AND status = 'pending'").bind(now, ws, userId).run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'invitation.revoked', targetType: 'member', targetId: userId }, now);
  return true;
}

export type MyInvitation = { workspaceId: string; workspaceName: string; expiresAt: string };
/** The invitations waiting for THIS signed-in identity (live, unexpired), keyed by the identity the invite was issued to. */
export async function listMyInvitations(env: Pick<Env, 'DB'>, userId: string, now = Date.now()): Promise<MyInvitation[]> {
  const rows = (await env.DB.prepare(
    "SELECT i.workspace_id AS workspace_id, w.name AS name, i.expires_at AS expires_at FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.user_id = ? AND i.status = 'pending' AND i.expires_at > ? AND w.suspended_at IS NULL ORDER BY i.created_at LIMIT 20",
  ).bind(userId, now).all<{ workspace_id: string; name: string; expires_at: number }>()).results ?? [];
  return rows.map((r) => ({ workspaceId: r.workspace_id, workspaceName: r.name, expiresAt: new Date(r.expires_at).toISOString() }));
}

export type AcceptResult = 'accepted' | 'not_found' | 'seat_limit';
/**
 * The invitee accepts, as themselves: an invitation exists only for the identity it was issued to, so another identity (or an expired / revoked / already-used one) finds nothing.
 * The seat is taken first (atomic in the Durable Object, the authority on room); then ONE batch makes the membership active and marks the invitation accepted, both only if the
 * invitation is STILL pending and unexpired (a revoke that raced us wins and the seat is given back).
 */
export async function acceptInvitation(env: Pick<Env, 'DB' | 'WORKSPACE_DO'>, userId: string, ws: string, now = Date.now()): Promise<AcceptResult> {
  if (!isStandaloneId(ws)) return 'not_found';
  const inv = await env.DB.prepare(
    "SELECT i.invited_by AS invited_by FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.workspace_id = ? AND i.user_id = ? AND i.status = 'pending' AND i.expires_at > ? AND w.suspended_at IS NULL",
  ).bind(ws, userId, now).first<{ invited_by: string }>();
  if (!inv) return 'not_found';
  const staff = (await env.DB.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'staff' AND status = 'active'").bind(ws).all<{ user_id: string }>()).results.map((r) => r.user_id);
  const stub = wsStub(env, ws);
  const seat = await stub.assignSeat(userId, inv.invited_by, [...new Set([...staff, userId])]);
  if (!seat.ok) return 'seat_limit';
  const STILL = "EXISTS (SELECT 1 FROM workspace_invitations WHERE workspace_id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?3)";
  const [member] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) SELECT ?1, ?2, 'staff', 'active', ?4, ?3, ?3 WHERE ${STILL}
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active', added_by = excluded.added_by, updated_at = excluded.updated_at WHERE workspace_members.role = 'staff'`,
    ).bind(ws, userId, now, inv.invited_by),
    env.DB.prepare(`UPDATE workspace_invitations SET status = 'accepted', decided_at = ?3 WHERE workspace_id = ?1 AND user_id = ?2 AND status = 'pending' AND expires_at > ?3`).bind(ws, userId, now),
  ]);
  if ((member?.meta.changes ?? 0) === 0) {
    // Either the invitation was withdrawn while we took the seat (give it back), or a concurrent accept of the same invitation already made us a member (keep it).
    const now_member = await env.DB.prepare("SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'").bind(ws, userId).first();
    if (!now_member) { await stub.removeSeat(userId); return 'not_found'; }
    return 'accepted';
  }
  await recordAudit(env as Env, { workspaceId: ws, actor: userId, role: 'staff', action: 'member.added', targetType: 'member', targetId: userId }, now);
  return 'accepted';
}

export type RemoveResult = 'removed' | 'not_found' | 'is_owner';

/** Owner removes a staff member: the row flips to `removed` (the middleware refuses them from the next request) and the seat is dropped in the same call. */
export async function removeStandaloneMember(env: Pick<Env, 'DB' | 'WORKSPACE_DO'> & Partial<Env>, ws: string, ownerId: string, userId: string, now = Date.now()): Promise<RemoveResult> {
  requireStandalone(ws);
  const row = await env.DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'").bind(ws, userId).first<{ role: 'owner' | 'staff' }>();
  if (!row) return 'not_found';
  if (row.role === 'owner') return 'is_owner';
  await env.DB.prepare("UPDATE workspace_members SET status = 'removed', updated_at = ? WHERE workspace_id = ? AND user_id = ? AND role = 'staff'").bind(now, ws, userId).run();
  await wsStub(env, ws).removeSeat(userId);
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'member.removed', targetType: 'member', targetId: userId }, now);
  return 'removed';
}
