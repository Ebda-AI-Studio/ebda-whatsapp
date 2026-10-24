const PREFIX = 'sha256=';

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Checks Meta's X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
export async function verifyMetaSignature(rawBody: ArrayBuffer, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith(PREFIX) || !appSecret) return false;
  const given = hexToBytes(header.slice(PREFIX.length));
  if (!given || given.length !== 32) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  return crypto.subtle.timingSafeEqual(expected, given);
}
