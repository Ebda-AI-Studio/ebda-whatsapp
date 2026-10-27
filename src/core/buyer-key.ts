import { isE164 } from './phone';

/** Suite-wide customer key: HMAC-SHA256(secret, E.164) as lowercase hex. Same function in every product. */
export async function buyerKey(secret: string, e164: string): Promise<string> {
  if (!isE164(e164)) throw new Error('buyerKey needs an E.164 number');
  return hmacHex(secret, e164);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * D4: the value every suite Worker publishes on /health (`buyerKeyVector`) so scripts/verify-prod.mjs can prove SUITE_BUYER_KEY_SECRET is the same on
 * both Workers without the secret leaving either. It is HMAC-SHA256(secret, BUYER_KEY_PROBE_INPUT) as lowercase hex, first 16 characters, through
 * the same HMAC path as `buyerKey` but over a domain-separated string that is NOT a phone number (it fails `normaliseE164` / `isE164`), so the
 * public value is never the buyer key of anyone, real or made up, and cannot be matched against a customer list.
 * The other suite Worker (the Store) must emit exactly this: `hmac_sha256_hex(SUITE_BUYER_KEY_SECRET, "suite-buyer-key-probe:v1").slice(0, 16)`.
 */
export const BUYER_KEY_PROBE_INPUT = 'suite-buyer-key-probe:v1';
export async function buyerKeyProbe(secret: string): Promise<string> {
  return (await hmacHex(secret, BUYER_KEY_PROBE_INPUT)).slice(0, 16);
}
