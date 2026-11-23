import { Hono } from 'hono';
import type { AuthVars } from '../core/identity/middleware';
import type { MyInvitationsResponse } from '../core/api/contract';
import { acceptInvitation, listMyInvitations } from '../core/standalone-members';
import { isStandaloneId } from '../core/workspace-kind';
import type { Env } from '../env';

type E = { Bindings: Env; Variables: AuthVars };
/**
 * CHAT-SA-4: a staff invitation is accepted by the invited person, signed in as that identity (person-level auth: `requirePerson` from identity/person.ts, mounted on `/workspaces/*` in index.ts: person token only, integrator tokens refused, session re-checked on a write). The invitation exists only for the identity it was
 * issued to, so every other identity gets the same 404 an unknown, expired, revoked or already-used invitation gets.
 */
export const invitationsRoutes = new Hono<E>();
const router = invitationsRoutes;

router.get('/workspaces/invitations', async (c) => {
  try {
    const items = await listMyInvitations(c.env, c.get('principal').userId);
    const body: MyInvitationsResponse = { items };
    return c.json(body);
  } catch {
    return c.json({ error: 'unavailable' }, 503);
  }
});

router.post('/workspaces/invitations/:workspaceId/accept', async (c) => {
  const ws = c.req.param('workspaceId');
  if (!isStandaloneId(ws)) return c.json({ error: 'not_found' }, 404);
  let r;
  try { r = await acceptInvitation(c.env, c.get('principal').userId, ws); } catch { return c.json({ error: 'unavailable' }, 503); }
  if (r === 'not_found') return c.json({ error: 'not_found' }, 404);
  if (r === 'seat_limit') return c.json({ error: 'seat_limit' }, 409);
  return c.json({ workspaceId: ws, status: 'accepted' as const });
});

