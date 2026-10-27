import { Hono } from 'hono';
import { offboardingRequest } from '../core/api/contract';
import type { AuthVars } from '../core/identity/middleware';
import { cancelOffboarding, getOffboarding, requestOffboarding } from '../core/ops/offboarding';
import type { Env } from '../env';

type E = { Bindings: Env; Variables: AuthVars };
/** /api/v1/stores/:storeId/offboarding: the owner asks to delete the workspace (14-day cooling-off), reads where it stands, or cancels. */
export const offboardingRoutes = new Hono<E>();
const ownerOnly = (role: string) => role === 'owner' || role === 'super_admin';

offboardingRoutes.get('/stores/:storeId/offboarding', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return c.json({ error: 'forbidden' }, 403);
  return c.json((await getOffboarding(c.env, c.req.param('storeId'))) ?? { state: 'none' });
});

offboardingRoutes.post('/stores/:storeId/offboarding', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return c.json({ error: 'forbidden' }, 403);
  const b = offboardingRequest.safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: 'invalid_request', message: 'confirmation_required' }, 400);
  const r = await requestOffboarding(c.env, { workspaceId: c.req.param('storeId'), actor: c.get('principal').userId, role: 'owner', ...b.data });
  if (r.ok) return c.json(r.value, 202);
  if (r.reason === 'not_found') return c.json({ error: 'not_found' }, 404);
  return c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
});

offboardingRoutes.delete('/stores/:storeId/offboarding', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return c.json({ error: 'forbidden' }, 403);
  const r = await cancelOffboarding(c.env, { workspaceId: c.req.param('storeId'), actor: c.get('principal').userId, role: c.get('storeRole') === 'super_admin' ? 'operator' : 'owner' });
  if (r.ok) return c.json({ ok: true });
  if (r.reason === 'operator_requested') return c.json({ error: 'forbidden', message: 'operator_requested' }, 403); // our team started it: only our team cancels it (the guides name the support address)
  return r.reason === 'not_found' ? c.json({ error: 'not_found' }, 404) : c.json({ error: 'invalid_request', message: r.reason, ...('amountMinor' in r ? { amountMinor: r.amountMinor } : {}) }, 409);
});
