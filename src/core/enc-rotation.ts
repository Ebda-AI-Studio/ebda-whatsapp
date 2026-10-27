import type { Env } from '../env';
import { encryptSecret } from './ai/secrets';
import { decryptAny, tokenKeys } from './enc-keys';

/**
 * Finishing a TOKEN_ENC_KEY rotation (M-173): every ciphertext the key protects is re-encrypted under the current key. The rows are the merchants'
 * business tokens (`waba_credentials.token_enc`) and the registration PINs (`phone_numbers.pin_enc`). Idempotent. Never reads a value out.
 *
 * COMPLETENESS IS THE POINT: the old key may be retired only when `complete: true`, i.e. EVERY row was examined and none still needs it. The walk pages
 * with a keyset cursor (`WHERE id > ? ORDER BY id LIMIT PAGE`) until the tables are exhausted; one request examines at most `budget` rows and, if that is
 * not enough, answers `truncated: true, complete: false` with a `nextCursor` to continue from. A partial scan can never read as "all rotated".
 */
type Kind = 'token' | 'pin';
type Row = { kind: Kind; id: string; ws: string; enc: string };
export const PAGE = 500;
export const DEFAULT_BUDGET = 10_000;

const SQL: Record<Kind, string> = {
  token: 'SELECT waba_id AS id, workspace_id AS ws, token_enc AS enc FROM waba_credentials WHERE waba_id > ? ORDER BY waba_id LIMIT ?',
  pin: 'SELECT phone_number_id AS id, workspace_id AS ws, pin_enc AS enc FROM phone_numbers WHERE pin_enc IS NOT NULL AND phone_number_id > ? ORDER BY phone_number_id LIMIT ?',
};
/** A cursor is `<kind>:<last id>`; the empty cursor starts at the tokens. */
const parse = (cursor: string | undefined): { kind: Kind; after: string } => {
  const m = /^(token|pin):(.*)$/s.exec(cursor ?? '');
  return m ? { kind: m[1] as Kind, after: m[2]! } : { kind: 'token', after: '' };
};

/** Visits rows in order, a page at a time, until the tables are exhausted or `budget` rows were examined. Returns the cursor to continue from, or null when exhausted. */
async function walk(env: Env, budget: number, cursor: string | undefined, visit: (r: Row) => Promise<void>): Promise<string | null> {
  let { kind, after } = parse(cursor);
  let seen = 0;
  for (;;) {
    const room = Math.min(PAGE, budget - seen);
    if (room <= 0) return `${kind}:${after}`;
    const page = (await env.DB.prepare(SQL[kind]).bind(after, room).all<{ id: string; ws: string; enc: string }>()).results;
    for (const r of page) await visit({ kind, ...r });
    seen += page.length;
    if (page.length < room) {
      if (kind === 'pin') return null; // both tables exhausted
      kind = 'pin';
      after = '';
    } else {
      after = page[page.length - 1]!.id;
    }
  }
}

export type RotationStatus = {
  /** Rows (in THIS pass) that only the previous key opens. */
  onPrevious: number;
  /** Rows no configured key opens (a restore from before a rotation, a corrupted value): never retire a key while this is above 0. */
  unreadable: number;
  /** Rows examined in this pass. */
  total: number;
  previousKeyConfigured: boolean;
  /** Every row was examined AND none needs the previous key AND none is unreadable. The ONLY signal to retire the old key. */
  complete: boolean;
  /** This pass stopped at its budget: its counts say nothing about the rows after `nextCursor`. */
  truncated: boolean;
  nextCursor: string | null;
};

export async function rotationStatus(env: Env, opts: { budget?: number; cursor?: string } = {}): Promise<RotationStatus> {
  const keys = tokenKeys(env);
  let onPrevious = 0;
  let unreadable = 0;
  let total = 0;
  const next = await walk(env, opts.budget ?? DEFAULT_BUDGET, opts.cursor, async (r) => {
    total++;
    const got = await decryptAny(r.enc, keys, r.ws);
    if (!got) unreadable++;
    else if (got.keyIndex > 0) onPrevious++;
  });
  const truncated = next !== null;
  // A continuation pass cannot vouch for rows before its cursor: only a pass that started at the beginning and ended exhausted can be complete.
  // With only TOKEN_ENC_KEY_PREVIOUS set the old key is the "current" one (index 0): nothing is on the previous key, but nothing was rotated either.
  const complete = !!env.TOKEN_ENC_KEY && !!env.TOKEN_ENC_KEY_PREVIOUS && !truncated && !opts.cursor && onPrevious === 0 && unreadable === 0;
  return { onPrevious, unreadable, total, previousKeyConfigured: keys.length > 1, complete, truncated, nextCursor: next };
}

export type RotateResult =
  | { ok: true; rotated: number; remaining: number; unreadable: number; complete: boolean; truncated: boolean; nextCursor: string | null }
  | { ok: false; reason: 'no_previous_key' | 'same_key' | 'no_current_key' };

/**
 * Re-encrypts up to `batch` rows that only the previous key opens, walking the WHOLE table (past rows already on the current key) within `budget`.
 * `complete` is true only when the walk was exhausted and nothing is left on the previous key or unreadable.
 */
export async function rotateTokenKey(env: Env, batch = 100, opts: { budget?: number; cursor?: string } = {}): Promise<RotateResult> {
  if (!env.TOKEN_ENC_KEY) return { ok: false, reason: 'no_current_key' };
  if (!env.TOKEN_ENC_KEY_PREVIOUS) return { ok: false, reason: 'no_previous_key' };
  if (env.TOKEN_ENC_KEY_PREVIOUS === env.TOKEN_ENC_KEY) return { ok: false, reason: 'same_key' };
  const keys = tokenKeys(env);
  let rotated = 0;
  let remaining = 0;
  let unreadable = 0;
  const next = await walk(env, opts.budget ?? DEFAULT_BUDGET, opts.cursor, async (r) => {
    const got = await decryptAny(r.enc, keys, r.ws);
    if (!got) { unreadable++; return; }
    if (got.keyIndex === 0) return;
    if (rotated >= batch) { remaining++; return; }
    const sealed = await encryptSecret(got.value, env.TOKEN_ENC_KEY!, r.ws);
    // Compare-and-set on the old ciphertext: a concurrent connect that wrote a fresh value is never overwritten with a stale one.
    const res = r.kind === 'token'
      ? await env.DB.prepare('UPDATE waba_credentials SET token_enc = ?, updated_at = ? WHERE waba_id = ? AND token_enc = ?').bind(sealed, Date.now(), r.id, r.enc).run()
      : await env.DB.prepare('UPDATE phone_numbers SET pin_enc = ? WHERE phone_number_id = ? AND pin_enc = ?').bind(sealed, r.id, r.enc).run();
    if (res.meta.changes > 0) rotated++;
    else remaining++;
  });
  const truncated = next !== null;
  return { ok: true, rotated, remaining, unreadable, complete: !truncated && !opts.cursor && remaining === 0 && unreadable === 0, truncated, nextCursor: next };
}
