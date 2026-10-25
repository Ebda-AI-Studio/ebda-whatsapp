/**
 * Who pays Meta for a number is written EXPLICITLY by the code path that creates it, never inferred: an own number's connect step calls
 * this with 'merchant_card'; the shared number's setup calls it with 'platform_line'. A number with no row is unknown and cannot send.
 */
import type { Env } from '../../env';

export type NumberFunding = 'merchant_card' | 'platform_line';

export async function recordNumberFunding(env: Pick<Env, 'DB'>, phoneNumberId: string, funding: NumberFunding, now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, ?)').bind(phoneNumberId, funding, now).run();
}

/** For a batch with the phone_numbers insert, so the number and its funding appear together. */
export const fundingStatement = (db: D1Database, phoneNumberId: string, funding: NumberFunding, now = Date.now()) =>
  db.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, ?)').bind(phoneNumberId, funding, now);
