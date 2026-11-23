/**
 * Ruling CHAT-SA-2: two workspace kinds with disjoint id spaces. A Store-linked workspace id IS the Store id (a Postgres UUID); a standalone workspace id is minted here as
 * `sw_` + 26 lowercase base32 chars (130 bits). The two shapes can never collide, and D1 checks `kind = 'standalone'` iff the id starts with `sw_` (migration 0042).
 * Every auth decision branches on the id SHAPE first (`isStoreId` / `isStandaloneId`), so a Store id can never take the standalone path and the reverse.
 */
export const STANDALONE_PREFIX = 'sw_';
const STANDALONE_ID = /^sw_[a-z2-7]{26}$/;
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const isStandaloneId = (id: string): boolean => STANDALONE_ID.test(id);
/** The shape the Store uses for its ids (a UUID). */
export const isStoreId = (id: string): boolean => STORE_ID.test(id);

/** `sw_` + 26 base32 chars from 26 random bytes (each byte masked to 5 bits, so the choice is uniform). */
export function mintStandaloneId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = STANDALONE_PREFIX;
  for (const b of bytes) out += B32[b & 31];
  return out;
}
