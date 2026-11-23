import type { MiddlewareHandler } from 'hono';
import type { Env } from '../../env';
import { integratorTokensEnabled, type AuthVars } from './middleware';
import { writeSessionState } from './session';
import { IdentityError, type IdentityVerifier, type Principal } from './verifier';

/**
 * Routes that belong to a PERSON, not to a workspace (`/workspaces/...`, CHAT-SA-8): a verified person token, never an integrator server token, and
 * a write re-checks the session like every workspace write (M-135; fail closed when accounts cannot answer). Sets `principal`.
 */
export function requirePerson(getVerifier: (env: Env) => IdentityVerifier): MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    let principal: Principal;
    try {
      principal = await getVerifier(c.env).verify(token, { integratorTokens: integratorTokensEnabled(c.env) });
    } catch (e) {
      const status = e instanceof IdentityError ? e.status : 401;
      return c.json({ error: status === 403 ? 'forbidden' : 'unauthorized' }, status);
    }
    if (principal.integration) return c.json({ error: 'forbidden' }, 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const s = await writeSessionState(c.env, principal.sessionId);
      if (s === 'revoked') return c.json({ error: 'forbidden', message: 'session_revoked' }, 403);
      if (s === 'unavailable') return c.json({ error: 'unavailable', message: 'session_check_unavailable' }, 503);
    }
    c.set('principal', principal);
    c.set('storeRole', 'owner'); // only so the audit row is not labelled an operator action: a person-level route has no workspace role yet
    await next();
  };
}
