/**
 * Ruling CHAT-SA-4: the team of a STANDALONE workspace lives here (D1 `workspace_members`), not in a Store. Owner + staff; a staff member works only while they hold a seat
 * (the Durable Object `seats` table, as for Store workspaces). Brand-neutral: the invitation mail copy lives in the accounts service (`inviteChatMember`).
 *
 * Every function here is for an `sw_` workspace only (callers branch on `isStandaloneId`). A membership change is never-stale: the middleware reads the row on every request,
 * so a removal takes effect on the very next call, and the seat is dropped in the same request.
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

/** The ACTIVE team from D1, names from accounts (one batched read). A name that cannot be read falls back to a short id: listing never fails on it. */
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

export type InviteResult = { status: 'invite_sent' } | { status: 'seat_limit'; limit: number } | { status: 'unavailable' } | { status: 'rate_limited'; retryAfterS: number };

/** The accounts mail cap is per ADDRESS only: without a cap here an owner could send branded mail to unlimited addresses. Counted from the audit log (one `member.invite_attempt` per call that reaches accounts, failures included). */
export const INVITE_CAP = { perWorkspaceDay: 20, perInviterDay: 30 } as const;
const DAY_MS = 86_400_000;
/** A workspace name goes into a mail subject: no line breaks or other control characters (header injection), no runs of space. */
export const mailSafeName = (name: string): string => name.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
async function inviteWindowFull(env: Pick<Env, 'DB'>, ws: string, inviter: string, now: number): Promise<boolean> {
  const since = now - DAY_MS;
  const [byWs, byInviter] = await env.DB.batch([
    env.DB.prepare("SELECT count(*) AS n FROM audit_log INDEXED BY audit_log_action WHERE action = 'member.invite_attempt' AND workspace_id = ? AND at > ?").bind(ws, since),
    env.DB.prepare("SELECT count(*) AS n FROM audit_log INDEXED BY audit_log_action WHERE action = 'member.invite_attempt' AND actor = ? AND at > ?").bind(inviter, since),
  ]);
  const n = (r: D1Result | undefined) => ((r?.results?.[0] as { n: number } | undefined)?.n ?? 0);
  return n(byWs) >= INVITE_CAP.perWorkspaceDay || n(byInviter) >= INVITE_CAP.perInviterDay;
}

/**
 * Owner invites a staff member by email. Order: seat room first (no accounts call and no mail when the package is full), then the accounts RPC (creates or resolves the identity and mails
 * it; the answer never says which), then the staff row, then the seat (atomic in the DO: two invites cannot both take the last seat). A seat race lost after the row was written
 * marks the row removed again. An accounts failure writes nothing. A refused identity (inactive/erased) is answered like a success and writes nothing (no account enumeration).
 */
export async function inviteStandaloneMember(env: Pick<Env, 'DB' | 'ACCOUNTS' | 'WORKSPACE_DO'> & Partial<Env>, ws: string, ownerId: string, a: InviteRequest, now = Date.now()): Promise<InviteResult> {
  requireStandalone(ws);
  const stub = wsStub(env, ws);
  const { limit } = await stub.seatSummary();
  const staff = (await env.DB.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'staff' AND status = 'active'").bind(ws).all<{ user_id: string }>()).results ?? [];
  if (staff.length >= limit - 1) return { status: 'seat_limit', limit };
  const accounts = env.ACCOUNTS as Accounts | undefined;
  if (typeof accounts?.inviteChatMember !== 'function') return { status: 'unavailable' };
  if (await inviteWindowFull(env, ws, ownerId, now)) return { status: 'rate_limited', retryAfterS: 3600 };
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'member.invite_attempt', targetType: 'member' }, now); // counted BEFORE the call: a failing accounts service does not make the cap unlimited
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
  const existing = await env.DB.prepare('SELECT role, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(ws, userId).first<{ role: string; status: string }>();
  if (existing?.role === 'owner') return { status: 'invite_sent' }; // the owner invited their own address: nothing to add, nothing to reveal
  await env.DB.prepare(
    "INSERT INTO workspace_members (workspace_id, user_id, role, status, added_by, created_at, updated_at) VALUES (?, ?, 'staff', 'active', ?, ?, ?) ON CONFLICT(workspace_id, user_id) DO UPDATE SET status = 'active', added_by = excluded.added_by, updated_at = excluded.updated_at WHERE workspace_members.role = 'staff'",
  ).bind(ws, userId, ownerId, now, now).run();
  const activeStaff = (await env.DB.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role = 'staff' AND status = 'active'").bind(ws).all<{ user_id: string }>()).results.map((r) => r.user_id);
  const seat = await stub.assignSeat(userId, ownerId, activeStaff);
  if (!seat.ok) {
    await env.DB.prepare("UPDATE workspace_members SET status = 'removed', updated_at = ? WHERE workspace_id = ? AND user_id = ? AND role = 'staff'").bind(now, ws, userId).run();
    return { status: 'seat_limit', limit: seat.limit };
  }
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'member.added', targetType: 'member', targetId: userId });
  return { status: 'invite_sent' };
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
  await recordAudit(env as Env, { workspaceId: ws, actor: ownerId, role: 'owner', action: 'member.removed', targetType: 'member', targetId: userId });
  return 'removed';
}
