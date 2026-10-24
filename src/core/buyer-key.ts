import { isE164 } from './phone';

/** Suite-wide customer key: HMAC-SHA256(secret, E.164) as lowercase hex. Same function in every product. */
export async function buyerKey(secret: string, e164: string): Promise<string> {
  if (!isE164(e164)) throw new Error('buyerKey needs an E.164 number');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(e164)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}
