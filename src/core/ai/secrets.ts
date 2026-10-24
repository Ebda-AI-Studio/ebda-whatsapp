/**
 * A workspace secret (a merchant's own model key) is stored AES-GCM encrypted under a platform key, with the workspace id
 * as associated data so a ciphertext copied into another workspace does not open. Format: `v1.<iv>.<ciphertext>` (base64url).
 */
const enc = new TextEncoder();
const b64 = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function importKey(masterKeyB64: string): Promise<CryptoKey> {
  const raw = unb64(masterKeyB64);
  if (raw.byteLength !== 32) throw new Error('secrets key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, masterKeyB64: string, workspaceId: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(workspaceId) }, await importKey(masterKeyB64), enc.encode(plain));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

/** The plain text, or null when the value is malformed, tampered with or belongs to another workspace/key. */
export async function decryptSecret(stored: string, masterKeyB64: string, workspaceId: string): Promise<string | null> {
  const [v, iv, ct] = stored.split('.');
  if (v !== 'v1' || !iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(workspaceId) }, await importKey(masterKeyB64), unb64(ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}
