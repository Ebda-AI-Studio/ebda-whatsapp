import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../env';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

export type AuthVars = { principal: Principal; storeRole: 'owner' | 'staff' | 'super_admin' };

/** Requires a valid bearer token whose principal may act on the `:storeId` route param. */
export function requireStoreAccess(getVerifier: (env: Env) => IdentityVerifier): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let principal: Principal;
    try {
      principal = await getVerifier(c.env).verify(token);
    } catch (e) {
      const status = e instanceof IdentityError ? e.status : 401;
      return c.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, status);
    }
    const storeId = c.req.param('storeId');
    const membership = principal.stores.find((s) => s.id === storeId);
    if (!membership && !principal.superAdmin) return c.json({ error: 'forbidden' }, 403);
    c.set('principal', principal);
    c.set('storeRole', membership?.role ?? 'super_admin');
    await next();
  };
}
