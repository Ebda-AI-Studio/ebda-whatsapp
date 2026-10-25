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

export async function sessionState(env: Env, sessionId: string): Promise<SessionState> {
  const check: Check | null = override ?? (env.ACCOUNTS ? (e, sid) => e.ACCOUNTS!.isRevoked(sid) : null);
  if (!check) return 'unavailable';
  try {
    return (await check(env, sessionId)) ? 'revoked' : 'ok';
  } catch {
    return 'unavailable';
  }
}
