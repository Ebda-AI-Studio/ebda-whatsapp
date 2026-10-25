import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../env';
import { integrationState } from './integration';
import { gateFor } from './scopes';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

export const integratorTokensEnabled = (env: Partial<Pick<Env, 'INTEGRATOR_TOKENS_ENABLED'>> | undefined): boolean => env?.INTEGRATOR_TOKENS_ENABLED === '1' || env?.INTEGRATOR_TOKENS_ENABLED?.toLowerCase() === 'true';

export type AuthVars = { principal: Principal; storeRole: 'owner' | 'staff' | 'super_admin' };

/** Requires a valid bearer token whose principal may act on the `:storeId` route param. */
export function requireStoreAccess(getVerifier: (env: Env) => IdentityVerifier): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // Browsers cannot set headers on a WebSocket, so the token may ride in Sec-WebSocket-Protocol as "bearer.<token>".
    if (!token && c.req.header('upgrade')?.toLowerCase() === 'websocket') {
      const offered = (c.req.header('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
      token = offered.find((p) => p.startsWith('bearer.'))?.slice(7) ?? '';
    }
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let principal: Principal;
    try {
      principal = await getVerifier(c.env).verify(token, { integratorTokens: integratorTokensEnabled(c.env) });
    } catch (e) {
      const status = e instanceof IdentityError ? e.status : 401;
      return c.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, status);
    }
    const storeId = c.req.param('storeId');
    const membership = principal.stores.find((s) => s.id === storeId);
    if (!membership && !principal.superAdmin) return c.json({ error: 'forbidden' }, 403);
    if (principal.integration) {
      // A merchant's server: still valid right now (fail closed), then the route map decides (default deny). Revoked first, so a revoked
      // client learns nothing about which routes exist.
      const state = await integrationState(c.env, principal.integration.clientId);
      if (state === 'revoked') return c.json({ error: 'unauthorized' }, 401);
      if (state === 'unavailable') return c.json({ error: 'rate_limited', message: 'session_check_unavailable' }, 503);
      const gate = gateFor(c.req.method, new URL(c.req.url).pathname.replace(/^\/api\/v1/, ''));
      if (gate === null || gate === 'person_only' || (gate !== 'any' && !principal.integration.scopes.includes(gate))) return c.json({ error: 'forbidden' }, 403);
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        // No message content, no phone numbers: who, where, and under which scope.
        console.log(JSON.stringify({ audit: 'integration_write', clientId: principal.integration.clientId, jti: principal.integration.jti, storeId, scope: gate }));
      }
    }
    c.set('principal', principal);
    c.set('storeRole', principal.superAdmin ? 'super_admin' : membership!.role);
    await next();
  };
}

/** Requires a valid bearer token of a super admin (`pa: super_admin`). No store membership is looked at: operator routes are not store-scoped. */
export function requireSuperAdmin(getVerifier: (env: Env) => IdentityVerifier): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let principal: Principal;
    try {
      principal = await getVerifier(c.env).verify(token, { integratorTokens: integratorTokensEnabled(c.env) }); // a client token verifies, then fails the super-admin test below
    } catch (e) {
      const status = e instanceof IdentityError ? e.status : 401;
      return c.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, status);
    }
    if (!principal.superAdmin) return c.json({ error: 'forbidden' }, 403);
    c.set('principal', principal);
    c.set('storeRole', 'super_admin');
    await next();
  };
}
