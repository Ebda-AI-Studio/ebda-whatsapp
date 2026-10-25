import type { Env } from '../../env';
import { decryptSecret } from '../ai/secrets';

/** The business token of a number's WABA is unusable (missing key, missing or unreadable credential). Never falls back to the platform token. */
export class TokenUnavailable extends Error {
  constructor(readonly reason: 'no_key' | 'no_credential' | 'unreadable') {
    super(`business token unavailable: ${reason}`);
  }
}

/**
 * Staleness class: BOUNDED-stale, TTL 60 s. Both caches answer "which token does this WABA / number use". They are cleared
 * synchronously by connect and disconnect (invalidateWaba / invalidateNumber) in the isolate that writes; other isolates
 * keep an old answer for at most 60 s. Residual: up to 60 s of sends with a revoked token (Meta rejects them, the send
 * fails and the existing retry pipeline handles it) or, right after a connect, up to 60 s on the platform token (Meta rejects those too).
 */
const TTL_MS = 60_000;
type Entry<T> = { value: T; until: number };
/** wabaId → the decrypted business token, or null when the WABA has no own credential (a platform WABA). */
const tokenByWaba = new Map<string, Entry<string | null>>();
/** phoneNumberId → its WABA when the number is a merchant's own, or null when it is a platform number or unknown. */
const ownWabaByNumber = new Map<string, Entry<string | null>>();

const fresh = <T>(m: Map<string, Entry<T>>, key: string): Entry<T> | undefined => {
  const e = m.get(key);
  return e && e.until > Date.now() ? e : undefined;
};

export function invalidateWaba(wabaId: string): void {
  tokenByWaba.delete(wabaId);
  for (const [pn, e] of ownWabaByNumber) if (e.value === wabaId) ownWabaByNumber.delete(pn);
}
export function invalidateNumber(phoneNumberId: string): void {
  ownWabaByNumber.delete(phoneNumberId);
}
/** Tests only: forget everything this isolate cached. */
export function clearTokenCaches(): void {
  tokenByWaba.clear();
  ownWabaByNumber.clear();
}

async function ownTokenOfWaba(env: Env, wabaId: string): Promise<string | null> {
  const hit = fresh(tokenByWaba, wabaId);
  if (hit) return hit.value;
  const row = await env.DB.prepare('SELECT workspace_id, token_enc FROM waba_credentials WHERE waba_id = ?').bind(wabaId).first<{ workspace_id: string; token_enc: string }>();
  let value: string | null = null;
  if (row) {
    if (!env.TOKEN_ENC_KEY) throw new TokenUnavailable('no_key');
    value = await decryptSecret(row.token_enc, env.TOKEN_ENC_KEY, row.workspace_id);
    if (value === null) throw new TokenUnavailable('unreadable'); // not cached: a fixed key or credential heals on the next call
  }
  tokenByWaba.set(wabaId, { value, until: Date.now() + TTL_MS });
  return value;
}

/**
 * The token for a Graph call about one WABA or one number: the decrypted business token for a merchant's own number,
 * else the platform token. An own WABA whose credential cannot be read throws TokenUnavailable (never the platform token).
 */
export async function graphTokenFor(env: Env, ref: { wabaId: string } | { phoneNumberId: string }): Promise<string> {
  let wabaId: string | null;
  if ('wabaId' in ref) wabaId = ref.wabaId;
  else {
    const hit = fresh(ownWabaByNumber, ref.phoneNumberId);
    if (hit) wabaId = hit.value;
    else {
      const row = await env.DB.prepare("SELECT waba_id FROM phone_numbers WHERE phone_number_id = ? AND kind = 'own'").bind(ref.phoneNumberId).first<{ waba_id: string }>();
      wabaId = row?.waba_id ?? null;
      ownWabaByNumber.set(ref.phoneNumberId, { value: wabaId, until: Date.now() + TTL_MS });
    }
  }
  if (wabaId === null) return env.META_SYSTEM_TOKEN;
  const own = await ownTokenOfWaba(env, wabaId);
  if (own !== null) return own;
  // A number flagged own whose WABA has no credential must not quietly send with the platform token.
  if ('phoneNumberId' in ref) throw new TokenUnavailable('no_credential');
  return env.META_SYSTEM_TOKEN;
}

/**
 * The merchant's OWN business token for a WABA, for calls that act on the merchant's assets (creating their catalog).
 * Unlike graphTokenFor it never falls back to the platform token: no credential row = TokenUnavailable('no_credential').
 */
export async function ownGraphTokenFor(env: Env, wabaId: string): Promise<string> {
  const own = await ownTokenOfWaba(env, wabaId);
  if (own === null) throw new TokenUnavailable('no_credential');
  return own;
}
