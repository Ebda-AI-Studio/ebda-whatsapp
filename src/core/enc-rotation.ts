import type { Env } from '../env';
import { encryptSecret } from './ai/secrets';
import { decryptAny, tokenKeys } from './enc-keys';

/**
 * Finishing a TOKEN_ENC_KEY rotation (M-173): every ciphertext the key protects is re-encrypted under the current key. The rows are the merchants'
 * business tokens (`waba_credentials.token_enc`) and the registration PINs (`phone_numbers.pin_enc`). Idempotent and batch-bounded: call until `remaining` is 0,
 * then remove TOKEN_ENC_KEY_PREVIOUS (docs/runbooks/token-enc-key-rotation.md). Never reads a value out: only counts and ids' worth of progress are returned.
 */
type Row = { kind: 'token' | 'pin'; id: string; ws: string; enc: string };
const SCAN_LIMIT = 5_000;

async function rows(env: Env): Promise<Row[]> {
  const t = await env.DB.prepare('SELECT waba_id AS id, workspace_id AS ws, token_enc AS enc FROM waba_credentials ORDER BY waba_id LIMIT ?').bind(SCAN_LIMIT).all<{ id: string; ws: string; enc: string }>();
  const p = await env.DB.prepare('SELECT phone_number_id AS id, workspace_id AS ws, pin_enc AS enc FROM phone_numbers WHERE pin_enc IS NOT NULL ORDER BY phone_number_id LIMIT ?').bind(SCAN_LIMIT).all<{ id: string; ws: string; enc: string }>();
  return [...t.results.map((r) => ({ kind: 'token' as const, ...r })), ...p.results.map((r) => ({ kind: 'pin' as const, ...r }))];
}

export async function rotationStatus(env: Env): Promise<{ onPrevious: number; unreadable: number; total: number; previousKeyConfigured: boolean }> {
  const keys = tokenKeys(env);
  let onPrevious = 0;
  let unreadable = 0;
  const all = await rows(env);
  for (const r of all) {
    const got = await decryptAny(r.enc, keys, r.ws);
    if (!got) unreadable++;
    else if (got.keyIndex > 0) onPrevious++;
  }
  return { onPrevious, unreadable, total: all.length, previousKeyConfigured: keys.length > 1 };
}

export type RotateResult = { ok: true; rotated: number; remaining: number; unreadable: number } | { ok: false; reason: 'no_previous_key' | 'same_key' | 'no_current_key' };

export async function rotateTokenKey(env: Env, batch = 100): Promise<RotateResult> {
  if (!env.TOKEN_ENC_KEY) return { ok: false, reason: 'no_current_key' };
  if (!env.TOKEN_ENC_KEY_PREVIOUS) return { ok: false, reason: 'no_previous_key' };
  if (env.TOKEN_ENC_KEY_PREVIOUS === env.TOKEN_ENC_KEY) return { ok: false, reason: 'same_key' };
  const keys = tokenKeys(env);
  let rotated = 0;
  let remaining = 0;
  let unreadable = 0;
  for (const r of await rows(env)) {
    const got = await decryptAny(r.enc, keys, r.ws);
    if (!got) { unreadable++; continue; }
    if (got.keyIndex === 0) continue;
    if (rotated >= batch) { remaining++; continue; }
    const next = await encryptSecret(got.value, env.TOKEN_ENC_KEY, r.ws);
    // Compare-and-set on the old ciphertext: a concurrent connect that wrote a fresh value is never overwritten with a stale one.
    const res = r.kind === 'token'
      ? await env.DB.prepare('UPDATE waba_credentials SET token_enc = ?, updated_at = ? WHERE waba_id = ? AND token_enc = ?').bind(next, Date.now(), r.id, r.enc).run()
      : await env.DB.prepare('UPDATE phone_numbers SET pin_enc = ? WHERE phone_number_id = ? AND pin_enc = ?').bind(next, r.id, r.enc).run();
    if (res.meta.changes > 0) rotated++;
    else remaining++;
  }
  return { ok: true, rotated, remaining, unreadable };
}
