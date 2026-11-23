import { Hono } from 'hono';
import type { AuthVars } from '../core/identity/middleware';
import type { ListMembersResponse } from '../core/api/contract';
import { bridgeForWorkspace } from '../core/store-link';
import type { StoreMember } from '../core/store-bridge';
import type { Env } from '../env';
import { inviteRequest, inviteStandaloneMember, listPendingInvitations, listStandaloneMembers, removeStandaloneMember, revokeInvitation } from '../core/standalone-members';
import { isStandaloneId } from '../core/workspace-kind';

type E = { Bindings: Env; Variables: AuthVars };
/**
 * /api/v1/stores/:storeId/members: the owner chooses which of the Store's staff hold a seat (WA-SEATS-1). Membership is the Store's (read live over the
 * service binding, never cached); the seat table is ours. A failure to read the Store is a 503 and changes nothing: it is never read as "no members".
 */
export const membersRoutes = new Hono<E>();

// The same shape the Store checks (a UUID); anything else is refused before it reaches the Store.
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Team = { ok: true; items: StoreMember[] } | { ok: false; status: 403 | 404 | 503; body: Record<string, unknown> };

/** The live team, asked AS the owner (the Store re-checks that the asker owns the store). */
async function team(c: { env: Env; get: (k: 'principal') => { userId: string } }, storeId: string): Promise<Team> {
  // CHAT-SA-4: a standalone workspace's team is the D1 membership (live), not a Store's.
  if (isStandaloneId(storeId)) {
    try { return { ok: true, items: await listStandaloneMembers(c.env, storeId) }; } catch { return { ok: false, status: 503, body: { error: 'unavailable', message: 'members_unavailable' } }; }
  }
  const bridge = bridgeForWorkspace(c.env, storeId);
  if (!bridge) return { ok: false, status: 404, body: { error: 'not_found', message: 'store_link_off' } };
  const r = await bridge.listStoreMembers(storeId, c.get('principal').userId);
  if (r.ok) return { ok: true, items: r.value.items };
  if (r.reason === 'invalid') return { ok: false, status: 403, body: { error: 'forbidden' } };
  return { ok: false, status: 503, body: { error: 'unavailable', message: 'members_unavailable' } };
}

membersRoutes.get('/stores/:storeId/members', async (c) => {
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const storeId = c.req.param('storeId');
  const t = await team(c, storeId);
  if (!t.ok) return c.json(t.body, t.status);
  const ws = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId));
  await ws.pruneSeats(t.items.filter((m) => m.role === 'staff').map((m) => m.userId));
  const { limit, seats } = await ws.seatSummary();
  const byUser = new Map(seats.map((s) => [s.userId, s.state]));
  const items: ListMembersResponse['items'] = t.items.map((m) => ({ ...m, seat: m.role === 'owner' ? 'owner' : (byUser.get(m.userId) ?? 'none') }));
  const staffSeats = seats.length;
  const body: ListMembersResponse = { items, seats: { limit, used: 1 + staffSeats, overLimit: seats.some((s) => s.state === 'over_limit') }, ...(isStandaloneId(storeId) ? { canInvite: true, invitations: await listPendingInvitations(c.env, storeId).catch(() => []) } : {}) };
  return c.json(body);
});

membersRoutes.put('/stores/:storeId/members/:userId/seat', async (c) => {
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const storeId = c.req.param('storeId');
  const userId = c.req.param('userId');
  if (!USER_ID.test(userId)) return c.json({ error: 'invalid_request', message: 'invalid_user' }, 400);
  const t = await team(c, storeId);
  if (!t.ok) return c.json(t.body, t.status);
  const target = t.items.find((m) => m.userId === userId);
  if (!target) return c.json({ error: 'not_found', message: 'not_a_member' }, 404);
  if (target.role === 'owner') return c.json({ error: 'invalid_request', message: 'owner_has_no_seat' }, 400);
  const ws = c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId));
  const r = await ws.assignSeat(userId, c.get('principal').userId, t.items.filter((m) => m.role === 'staff').map((m) => m.userId));
  if (!r.ok) return c.json({ error: 'seat_limit', limit: r.limit }, 403);
  return c.json({ userId, seat: 'seated' }, r.created ? 201 : 200);
});

membersRoutes.delete('/stores/:storeId/members/:userId/seat', async (c) => {
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const storeId = c.req.param('storeId');
  const userId = c.req.param('userId');
  if (!USER_ID.test(userId)) return c.json({ error: 'invalid_request', message: 'invalid_user' }, 400);
  // The owner cannot be unseated: they never had a row. Asking the Store is not needed to know a user id is not ours to remove; but the owner check needs the live team.
  const t = await team(c, storeId);
  if (!t.ok) return c.json(t.body, t.status);
  if (t.items.find((m) => m.userId === userId)?.role === 'owner') return c.json({ error: 'invalid_request', message: 'owner_has_no_seat' }, 400);
  await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId)).removeSeat(userId);
  return c.body(null, 204);
});

/** POST /members/invite (standalone only, owner only): 202 {status:'invite_sent'} whether or not the address already had an account; 409 seat_limit when the package is full. */
membersRoutes.post('/stores/:storeId/members/invite', async (c) => {
  const storeId = c.req.param('storeId');
  if (!isStandaloneId(storeId)) return c.json({ error: 'not_found' }, 404);
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const body = inviteRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  let r;
  try { r = await inviteStandaloneMember(c.env, storeId, c.get('principal').userId, body.data); } catch { return c.json({ error: 'unavailable', message: 'members_unavailable' }, 503); }
  if (r.status === 'seat_limit') return c.json({ error: 'seat_limit', limit: r.limit }, 409);
  if (r.status === 'rate_limited') return c.json({ error: 'rate_limited', message: 'invite_rate_limited' }, 429, { 'retry-after': String(r.retryAfterS) });
  if (r.status === 'unavailable') return c.json({ error: 'unavailable', message: 'invite_unavailable' }, 503);
  return c.json({ status: 'invite_sent' as const }, 202);
});

/** DELETE /members/:userId (standalone only, owner only): removes a staff member; the owner cannot be removed. */
membersRoutes.delete('/stores/:storeId/members/:userId', async (c) => {
  const storeId = c.req.param('storeId');
  if (!isStandaloneId(storeId)) return c.json({ error: 'not_found' }, 404);
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const userId = c.req.param('userId');
  if (!USER_ID.test(userId)) return c.json({ error: 'invalid_request', message: 'invalid_user' }, 400);
  let r;
  try { r = await removeStandaloneMember(c.env, storeId, c.get('principal').userId, userId); } catch { return c.json({ error: 'unavailable', message: 'members_unavailable' }, 503); }
  if (r === 'not_found') return c.json({ error: 'not_found', message: 'not_a_member' }, 404);
  if (r === 'is_owner') return c.json({ error: 'invalid_request', message: 'owner_cannot_be_removed' }, 400);
  return c.body(null, 204);
});

/** DELETE /members/invitations/:userId (standalone only, owner only): withdraws a pending invitation; the emailed link stops working. */
membersRoutes.delete('/stores/:storeId/members/invitations/:userId', async (c) => {
  const storeId = c.req.param('storeId');
  if (!isStandaloneId(storeId)) return c.json({ error: 'not_found' }, 404);
  if (c.get('storeRole') !== 'owner') return c.json({ error: 'forbidden' }, 403);
  const userId = c.req.param('userId');
  if (!USER_ID.test(userId)) return c.json({ error: 'invalid_request', message: 'invalid_user' }, 400);
  let ok;
  try { ok = await revokeInvitation(c.env, storeId, c.get('principal').userId, userId); } catch { return c.json({ error: 'unavailable', message: 'members_unavailable' }, 503); }
  return ok ? c.body(null, 204) : c.json({ error: 'not_found', message: 'no_pending_invitation' }, 404);
});
