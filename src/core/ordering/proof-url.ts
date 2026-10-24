/** Short-lived signed links to a customer's payment screenshot, so the Store can fetch it without a login. */
export const PROOF_URL_TTL_MS = 72 * 60 * 60 * 1000;

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signProofUrl(opts: { baseUrl: string; secret: string; workspaceId: string; messageId: number; now: number }): Promise<string> {
  const exp = opts.now + PROOF_URL_TTL_MS;
  const sig = await hmacHex(opts.secret, `${opts.workspaceId}.${opts.messageId}.${exp}`);
  return `${opts.baseUrl}/api/v1/proof/${encodeURIComponent(opts.workspaceId)}/${opts.messageId}?exp=${exp}&sig=${sig}`;
}

export async function verifyProofSig(opts: { secret: string; workspaceId: string; messageId: number; exp: number; sig: string; now: number }): Promise<boolean> {
  if (!Number.isSafeInteger(opts.exp) || opts.exp < opts.now || opts.exp > opts.now + PROOF_URL_TTL_MS + 60_000) return false;
  const want = new TextEncoder().encode(await hmacHex(opts.secret, `${opts.workspaceId}.${opts.messageId}.${opts.exp}`));
  const got = new TextEncoder().encode(opts.sig);
  return want.byteLength === got.byteLength && crypto.subtle.timingSafeEqual(want, got);
}
