import { decryptSecret } from './ai/secrets';
import type { Env } from '../env';

/**
 * TOKEN_ENC_KEY rotation (M-173). WRITES always use `TOKEN_ENC_KEY`. READS try it first and then `TOKEN_ENC_KEY_PREVIOUS` (when set), so a
 * deploy that changes the key never leaves a credential unreadable; `src/core/enc-rotation.ts` then re-encrypts every row, after which the previous key
 * is removed. A ciphertext opens under a key only for the workspace it was written for (AES-GCM associated data), under either key.
 */
export function tokenKeys(env: Pick<Env, 'TOKEN_ENC_KEY' | 'TOKEN_ENC_KEY_PREVIOUS'>): string[] {
  const keys: string[] = [];
  if (env.TOKEN_ENC_KEY) keys.push(env.TOKEN_ENC_KEY);
  if (env.TOKEN_ENC_KEY_PREVIOUS && env.TOKEN_ENC_KEY_PREVIOUS !== env.TOKEN_ENC_KEY) keys.push(env.TOKEN_ENC_KEY_PREVIOUS);
  return keys;
}

/** The plain text and which key opened it (0 = current, 1 = previous), or null when none of the keys does. */
export async function decryptAny(stored: string, keys: string[], workspaceId: string): Promise<{ value: string; keyIndex: number } | null> {
  for (let i = 0; i < keys.length; i++) {
    const value = await decryptSecret(stored, keys[i]!, workspaceId).catch(() => null);
    if (value !== null) return { value, keyIndex: i };
  }
  return null;
}
