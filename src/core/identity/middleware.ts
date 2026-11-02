import { LAST_REASON_ID, REASON_PLACEHOLDER, reasonStmt } from '../audit-reason';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../env';
import { takeApiToken } from '../api-rate';
import { recordAudit, type AuditRole } from '../audit';
import { integrationState } from './integration';
import { writeSessionState } from './session';
import { routePath } from 'hono/route';
import { subjectHash } from '../erasure';
import { bridgeFor } from '../store-link';
import { phoneDigits } from '../text-normalise';
import { SESSION_CHECKED_READS, gateForRoute } from './scopes';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

export const integratorTokensEnabled = (env: Partial<Pick<Env, 'INTEGRATOR_TOKENS_ENABLED'>> | undefined): boolean => env?.INTEGRATOR_TOKENS_ENABLED === '1' || env?.INTEGRATOR_TOKENS_ENABLED?.toLowerCase() === 'true';

export type AuthVars = { principal: Principal; storeRole: 'owner' | 'staff' | 'super_admin' };

/**
 * What a suspended workspace may still do: pay (wallet, packages) and erase a contact (a data-protection right never waits on a suspension).
 * Decided on the ROUTED pattern (`/stores/:storeId/wallet/topups`, as Hono matched it), never on the raw URL: an encoded or odd spelling of a path reaches the
 * same handler and must get the same answer.
 */
export function allowedWhileSuspended(method: string, pattern: string): boolean {
  for (const prefix of ['/stores/:storeId/wallet', '/stores/:storeId/packages']) if (pattern === prefix || pattern.startsWith(`${prefix}/`)) return true;
  // Asking to delete the workspace is a right a suspension never blocks; cancelling is not (a suspended store may be suspended for abuse).
  if ((method === 'POST' || method === 'GET') && pattern === '/stores/:storeId/offboarding') return true;
  return method === 'DELETE' && pattern === '/stores/:storeId/contacts/:waId';
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
    const write = c.req.method !== 'GET' && c.req.method !== 'HEAD';
    const routed = routePath(c, -1).replace(/^\/api\/v1/, ''); // the pattern of the handler that WILL answer; every decision below uses it
    // A write refused HERE never reaches `auditWrites` (it is mounted after this guard), so the refusal is recorded now: who, the routed pattern, the status; never a body (review item 13).
    const refuse = async (error: string, status: 403, extra: Record<string, unknown> = {}) => {
      if (write) {
        const role: AuditRole = principal.integration ? 'integration' : principal.superAdmin ? 'operator' : membership?.role === 'owner' ? 'owner' : 'staff';
        await recordAudit(c.env, { workspaceId: storeId ?? null, actor: principal.integration ? `client:${principal.integration.clientId}` : principal.userId, role, action: `${c.req.method} ${routed}`, status });
      }
      return c.json({ error, ...extra }, status);
    };
    if (!membership && !principal.superAdmin) return refuse('forbidden', 403);
    // I3: a platform super admin who is NOT a member reads a store only AS an operator looking at a merchant's workspace: the view-as header and a reason (audited below), on EVERY store
    // route. Without them the read is refused and nothing is served or logged. (A write keeps its own refusal further down: operator_route_required.) Members are unaffected.
    const viewAs = c.req.header('x-view-as-merchant') === '1';
    if (storeId && !membership && principal.superAdmin && !principal.integration && !viewAs && !write) return c.json({ error: 'forbidden', message: 'view_as_required' }, 403);
    // T35: an operator looking at a merchant's workspace to help them. Read-only, a reason on every request, audited BEFORE it is served (no audit, no view).
    if (viewAs) {
      if (!principal.superAdmin) return c.json({ error: 'forbidden', message: 'view_as_operators_only' }, 403);
      const reason = (c.req.header('x-view-as-reason') ?? '').trim();
      if (reason.length < 10 || reason.length > 200) return c.json({ error: 'invalid_request', message: 'view_as_reason_required' }, 400);
      // I4: the ROUTED pattern (as every other check uses) and the concrete route params as keyed hashes, never the raw path or a param value. A waId is reduced to its digits first
      // (`%2B20...`, Arabic-Indic digits and `20-100-...` are the same person) and hashed as the erasure subject; every other param is hashed under its name.
      const hashes: Record<string, string> = {};
      // The params of the handler that WILL answer: this middleware runs before it, so they are read off the routed pattern against the path, segment by segment (decoded).
      const patternParts = routed.split('/');
      const pathParts = new URL(c.req.url).pathname.replace(/^\/api\/v1/, '').split('/');
      for (let i = 0; i < patternParts.length; i++) {
        const m = /^:([A-Za-z0-9_]+)/.exec(patternParts[i]!);
        if (!m || pathParts[i] === undefined) continue;
        let value = pathParts[i]!;
        try { value = decodeURIComponent(value); } catch { /* keep the raw segment: it is only hashed */ }
        const name = m[1]!;
        const h = await subjectHash(c.env, storeId ?? '', name === 'waId' ? phoneDigits(value) : `${name}:${value}`);
        if (h === null) return c.json({ error: 'unavailable', message: 'view_as_audit_unavailable' }, 503); // no key, no audit, no view
        hashes[name] = h;
      }
      const route = routed;
      try {
        const at = Date.now();
        // AUDIT-REASONS-1: the typed reason goes to the deletable audit_reasons (removed with the workspace); the immutable row keeps only reason_id. One batch: no audit, no view.
        await c.env.DB.batch([
          reasonStmt(c.env, { at, workspaceId: storeId ?? null, actor: principal.userId, action: 'operator.view_as', reason }),
          c.env.DB.prepare(`INSERT INTO operator_view_log (at, actor, workspace_id, method, route, reason, reason_id, params) VALUES (?, ?, ?, ?, ?, ?, ${LAST_REASON_ID}, ?)`).bind(at, principal.userId, storeId ?? '', c.req.method, route.slice(0, 300), REASON_PLACEHOLDER, JSON.stringify(hashes)),
        ]);
      } catch {
        return c.json({ error: 'unavailable', message: 'view_as_audit_unavailable' }, 503);
      }
      if (write || c.req.header('upgrade')?.toLowerCase() === 'websocket') return c.json({ error: 'forbidden', message: 'view_as_read_only' }, 403);
    }
    // STORE-ROUTES-OWNER-1: a platform super admin who is not a member READS store routes (support) but never WRITES through them: an operator write has an /operator route that requires a reason and is audited.
    if (write && principal.superAdmin && !membership) return refuse('forbidden', 403, { message: 'operator_route_required' });
    // M-135: a person token is revocation-checked on EVERY write, not only on money actions (fail closed: an unreachable accounts service refuses it).
    // A read that hands over a person's whole data is checked like a write; which reads those are is a named list (scopes.ts), and every read route must be on one list or the other.
    const sensitiveRead = !write && SESSION_CHECKED_READS.has(`GET ${routed}`);
    if ((write || sensitiveRead) && !principal.integration) {
      const s = await writeSessionState(c.env, principal.sessionId);
      if (s === 'revoked') return refuse('forbidden', 403, { message: 'session_revoked' });
      if (s === 'unavailable') return c.json({ error: 'unavailable', message: 'session_check_unavailable' }, 503);
    }
    // The operator kill switch (W2-OPS), read from D1 on every request that needs it (a NEVER-stale gate, no cache): every integrator token is refused
    // while `integrations_revoked_at` is set, and a suspended workspace takes no writes except paying, and erasing a contact.
    if (storeId && (write || principal.integration)) {
      const flags = await c.env.DB.prepare('SELECT suspended_at, integrations_revoked_at FROM workspaces WHERE id = ?').bind(storeId).first<{ suspended_at: number | null; integrations_revoked_at: number | null }>();
      if (principal.integration && flags?.integrations_revoked_at != null) return c.json({ error: 'unauthorized' }, 401); // the operator revoked this store's integrations: EVERY server token is refused (a client re-mints every few minutes, so an issue-time cut-off would not hold) until the operator restores them
      if (write && flags?.suspended_at != null && !principal.superAdmin && !allowedWhileSuspended(c.req.method, routed)) return refuse('forbidden', 403, { message: 'workspace_suspended' });
    }
    if (principal.integration) {
      // A merchant's server: still valid right now (fail closed), then the route map decides (default deny). Revoked first, so a revoked
      // client learns nothing about which routes exist.
      const state = await integrationState(c.env, principal.integration.clientId);
      if (state === 'revoked') return c.json({ error: 'unauthorized' }, 401);
      if (state === 'unavailable') return c.json({ error: 'rate_limited', message: 'session_check_unavailable' }, 503);
      const gate = gateForRoute(c.req.method, routed);
      if (gate === null || gate === 'person_only' || (gate !== 'any' && !principal.integration.scopes.includes(gate))) return refuse('forbidden', 403);
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        // No message content, no phone numbers: who, where, and under which scope.
        console.log(JSON.stringify({ audit: 'integration_write', clientId: principal.integration.clientId, jti: principal.integration.jti, storeId, scope: gate }));
      }
    }
    // WA-SEATS-1 (deny by default): a person who is a member by TOKEN is checked against the Store's LIVE membership on EVERY request (a permission is never-stale, so no cache; a token
    // can be 15 minutes behind). Staff must also hold a seat the owner assigned, inside the package's limit. No Store answer = 503 (fail closed), never "allowed". This runs before the
    // rate limit so a removed member's requests never spend the workspace's allowance. Without a Store link (a white-label deploy, no binding) there is no membership source and no seats.
    let effectiveRole: 'owner' | 'staff' | undefined;
    if (storeId && membership && !principal.superAdmin && !principal.integration) {
      const bridge = c.env ? bridgeFor(c.env) : null; // a unit test mounting this middleware alone has no env; the Worker always has one
      if (bridge) {
        const live = await bridge.memberRole(storeId, principal.userId);
        if (!live.ok) return c.json({ error: 'unavailable', message: 'membership_unavailable' }, 503);
        if (live.value.role === null) return refuse('no_seat', 403, { message: 'not_a_member' });
        // The LOWER of the token's role and the Store's: a token that is stale in either direction can never grant more than the Store says now (an owner demoted to staff is a
        // seated-staff member from this request on; a staff member the Store now calls owner stays staff until the token refreshes).
        effectiveRole = live.value.role === 'staff' || membership.role === 'staff' ? 'staff' : 'owner';
        if (effectiveRole === 'staff') {
          const seat = await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId)).seatOf(principal.userId);
          if (seat !== 'seated') return refuse('no_seat', 403, { message: seat === 'over_limit' ? 'seat_over_limit' : 'no_seat' });
        }
      }
    }
    // F4: per-workspace and per-integrator-client rate limit, taken only AFTER the revocation checks (session, kill switch, integration state): a refused request (a revoked
    // token, a suspended store) never spends the workspace's allowance, so a flood of dead tokens cannot lock the owner out. A platform operator is not limited by a store's bucket.
    if (storeId && !principal.superAdmin) {
      const wait = takeApiToken(storeId, principal.integration?.clientId ?? null);
      if (wait) return c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(wait) });
    }
    // A merchant's server needs the `api` feature in the plan (deny by default: no entitlement = no API). Checked on EVERY route, GET /me included,
    // from the workspace's own copy; an unregistered workspace has no copy, so it is refused without creating a Durable Object.
    if (principal.integration && !principal.superAdmin) {
      const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first();
      const allowed = known ? await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(storeId!)).planAllows('api') : false;
      if (!allowed) return refuse('plan_feature', 403, { feature: 'api' });
    }
    c.set('principal', principal);
    c.set('storeRole', principal.superAdmin ? 'super_admin' : (effectiveRole ?? membership!.role));
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
