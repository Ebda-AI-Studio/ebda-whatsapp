/**
 * Is this session still valid right now? Privileged money actions (starting a top-up, every state-changing operator action) ask the accounts
 * service `isRevoked(sessionId)`. FAIL CLOSED: a missing binding or an error is "unavailable", never "fine".
 */
import type { Env } from '../../env';

export type SessionState = 'ok' | 'revoked' | 'unavailable';
type Check = (env: Env, sessionId: string) => Promise<boolean>;
let override: Check | null = null;
/** Tests only: replaces the accounts binding. Pass null to go back to the binding. */
export const configureSessionCheck = (c: ((sid: string) => Promise<boolean>) | null): void => { override = c ? (_env, sid) => c(sid) : null; };

/**
 * Tests only: the answer the every-write check (M-135, in the store middleware) gets when a test installed no explicit check with
 * `configureSessionCheck`. Money routes and the operator guard never use it: they keep asking the binding (or the explicit override) themselves, so a
 * test that injects `env.ACCOUNTS` still decides those. Production never sets it.
 */
let writeDefault: Check | null = null;
export const configureWriteSessionDefault = (c: ((sid: string) => Promise<boolean>) | null): void => { writeDefault = c ? (_env, sid) => c(sid) : null; };

/** The every-write check for a person token (M-135): same fail-closed answer as `sessionState`. */
export const writeSessionState = (env: Env, sessionId: string): Promise<SessionState> => sessionStateWith(env, sessionId, override ?? writeDefault);

export const sessionState = (env: Env, sessionId: string): Promise<SessionState> => sessionStateWith(env, sessionId, override);

async function sessionStateWith(env: Env, sessionId: string, explicit: Check | null): Promise<SessionState> {
  const check: Check | null = explicit ?? (env.ACCOUNTS ? (e, sid) => e.ACCOUNTS!.isRevoked(sid) : null);
  if (!check) return 'unavailable';
  try {
    return (await check(env, sessionId)) ? 'revoked' : 'ok';
  } catch {
    return 'unavailable';
  }
}
