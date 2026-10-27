/**
 * Boot-time shape check for the Worker's own secrets, run by /health so a malformed value is caught at deploy, not at the first
 * number connect or agent save. Returns the NAMES of the problem keys (never a value). A key that is set must be well-formed; a key
 * listed in the `REQUIRED_SECRETS` var (comma-separated, per deployment) must also be set.
 */
const B64_32 = ['TOKEN_ENC_KEY', 'TOKEN_ENC_KEY_PREVIOUS', 'AGENT_SECRETS_KEY'] as const; // AES-256 keys: base64 or base64url of exactly 32 bytes
const MIN_32_CHARS = ['PROOF_URL_SECRET', 'SUITE_BUYER_KEY_SECRET', 'BACKUP_HMAC_KEY', 'BACKUP_HMAC_KEY_PREVIOUS'] as const; // HMAC/HKDF input: at least 32 characters

function decodedLength(v: string): number | null {
  try {
    return atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')).length;
  } catch {
    return null;
  }
}

export function secretProblems(env: Record<string, unknown>): string[] {
  const value = (k: string) => (typeof env[k] === 'string' && env[k] !== '' ? (env[k] as string) : undefined);
  const bad = new Set<string>();
  for (const k of B64_32) { const v = value(k); if (v !== undefined && decodedLength(v.trim()) !== 32) bad.add(k); }
  for (const k of MIN_32_CHARS) { const v = value(k); if (v !== undefined && v.length < 32) bad.add(k); }
  for (const k of String(env.REQUIRED_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (value(k) === undefined) bad.add(k);
  return [...bad].sort();
}
