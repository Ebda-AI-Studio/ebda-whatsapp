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
 * D4: the value every suite Worker publishes on /health (`buyerKeyVector`) so a deploy check can prove SUITE_BUYER_KEY_SECRET is the same
 * on every Worker without the secret leaving any. HMAC-SHA256(secret, BUYER_KEY_PROBE_INPUT) as lowercase hex, first 16 characters, over a
 * domain-separated string that is NOT a phone number (it fails `normaliseE164` / `isE164`), so the public value is never anyone's buyer key.
 */
/** The probe is published only when the secret has at least this many characters (the real one is 64 hex): on a short secret it would be an offline-guessing oracle. */
export const MIN_PROBE_SECRET_LENGTH = 64;
export const BUYER_KEY_PROBE_INPUT = 'suite-buyer-key-probe:v1';
export async function buyerKeyProbe(secret: string): Promise<string> {
  // Checked here, not only advertised: a public probe of a short secret is an offline-guessing oracle. /health callers catch this and omit the field.
  if (secret.length < MIN_PROBE_SECRET_LENGTH) throw new Error('weak probe secret');
  return (await hmacHex(secret, BUYER_KEY_PROBE_INPUT)).slice(0, 16);
}
