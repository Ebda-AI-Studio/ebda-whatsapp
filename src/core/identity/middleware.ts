import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../env';
import { integrationState } from './integration';
import { writeSessionState } from './session';
import { gateFor } from './scopes';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

export const integratorTokensEnabled = (env: Partial<Pick<Env, 'INTEGRATOR_TOKENS_ENABLED'>> | undefined): boolean => env?.INTEGRATOR_TOKENS_ENABLED === '1' || env?.INTEGRATOR_TOKENS_ENABLED?.toLowerCase() === 'true';

export type AuthVars = { principal: Principal; storeRole: 'owner' | 'staff' | 'super_admin' };

/** What a suspended workspace may still do: pay (wallet, packages) and erase a contact (a data-protection right never waits on a suspension). */
const SUSPENDED_OK = [/^\/api\/v1\/stores\/[^/]+\/wallet(\/|$)/, /^\/api\/v1\/stores\/[^/]+\/packages(\/|$)/];
export function allowedWhileSuspended(method: string, path: string): boolean {
  if (SUSPENDED_OK.some((re) => re.test(path))) return true;
  return method === 'DELETE' && /^\/api\/v1\/stores\/[^/]+\/contacts\/[^/]+$/.test(path);
}

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
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    // T35: an operator looking at a merchant's workspace to help them. Read-only, a reason on every request, audited BEFORE it is served (no audit, no view).
    if (c.req.header('x-view-as-merchant') === '1') {
      if (!principal.superAdmin) return c.json({ error: 'forbidden', message: 'view_as_operators_only' }, 403);
      const reason = (c.req.header('x-view-as-reason') ?? '').trim();
      if (reason.length < 10 || reason.length > 200) return c.json({ error: 'invalid_request', message: 'view_as_reason_required' }, 400);
      const route = new URL(c.req.url).pathname.replace(/^\/api\/v1/, '').replace(/\/\d{6,}(?=\/|$)/g, '/:id');
      try {
        await c.env.DB.prepare('INSERT INTO operator_view_log (at, actor, workspace_id, method, route, reason) VALUES (?, ?, ?, ?, ?, ?)').bind(Date.now(), principal.userId, storeId ?? '', c.req.method, route.slice(0, 300), reason).run();
      } catch {
        return c.json({ error: 'unavailable', message: 'view_as_audit_unavailable' }, 503);
      }
      if (write || c.req.header('upgrade')?.toLowerCase() === 'websocket') return c.json({ error: 'forbidden', message: 'view_as_read_only' }, 403);
    }
    // M-135: a person token is revocation-checked on EVERY write, not only on money actions (fail closed: an unreachable accounts service refuses it).
    if (write && !principal.integration) {
      const s = await writeSessionState(c.env, principal.sessionId);
      if (s === 'revoked') return c.json({ error: 'forbidden', message: 'session_revoked' }, 403);
      if (s === 'unavailable') return c.json({ error: 'unavailable', message: 'session_check_unavailable' }, 503);
    }
    // The operator kill switch (W2-OPS), read from D1 on every request that needs it (a NEVER-stale gate, no cache): every integrator token is refused
    // while `integrations_revoked_at` is set, and a suspended workspace takes no writes except paying, and erasing a contact.
    if (storeId && (write || principal.integration)) {
      const flags = await c.env.DB.prepare('SELECT suspended_at, integrations_revoked_at FROM workspaces WHERE id = ?').bind(storeId).first<{ suspended_at: number | null; integrations_revoked_at: number | null }>();
      if (principal.integration && flags?.integrations_revoked_at != null) return c.json({ error: 'unauthorized' }, 401); // the operator revoked this store's integrations: EVERY server token is refused (a client re-mints every few minutes, so an issue-time cut-off would not hold) until the operator restores them
      if (write && flags?.suspended_at != null && !principal.superAdmin && !allowedWhileSuspended(c.req.method, new URL(c.req.url).pathname)) return c.json({ error: 'forbidden', message: 'workspace_suspended' }, 403);
    }
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
    // A merchant's server needs the `api` feature in the plan (deny by default: no entitlement = no API). Checked on EVERY route, GET /me included,
    // from the workspace's own copy; an unregistered workspace has no copy, so it is refused without creating a Durable Object.
    if (principal.integration && !principal.superAdmin) {
      const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first();
      const allowed = known ? await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId!)).planAllows('api') : false;
      if (!allowed) return c.json({ error: 'plan_feature', feature: 'api' }, 403);
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
