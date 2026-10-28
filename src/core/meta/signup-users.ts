import type { Env } from '../../env';
import { subjectHash } from '../erasure';

/**
 * The keyed hash of a Meta (app-scoped) user id, under ERASURE_HMAC_KEY (ERASURE-KEY-1: never rotated) with its own namespace, so it is not a phone-number hash and is
 * not bound to a workspace. Null = no key: nothing is recorded or matched.
 */
export const metaUserHash = (env: Pick<Env, 'ERASURE_HMAC_KEY'>, userId: string): Promise<string | null> => subjectHash(env, 'meta-user', userId);

/** Remembers that this person connected this WABA (hash only). Never throws and never blocks a connect: a person who cannot be recorded just cannot be found by Meta's callback. */
export async function recordSignupUser(env: Env, workspaceId: string, wabaId: string, userId: string | null, now: number): Promise<void> {
  if (!userId) return;
  try {
    const h = await metaUserHash(env, userId);
    if (!h) return;
    await env.DB.prepare('INSERT OR IGNORE INTO waba_signup_users (waba_id, workspace_id, user_hash, first_seen_at) VALUES (?, ?, ?, ?)').bind(wabaId, workspaceId, h, now).run();
  } catch {
    // best effort by design (see above)
  }
}
