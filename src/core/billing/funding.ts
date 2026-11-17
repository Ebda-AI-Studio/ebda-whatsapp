/**
 * Who pays Meta for a number is written EXPLICITLY by the code path that creates it, never inferred: an own number's connect step calls
 * this with 'merchant_card'; the shared number's setup calls it with 'platform_line'. A number with no row is unknown and cannot send.
 */
import type { Env } from '../../env';
import { billingAudit } from '../audit-reason';

export type NumberFunding = 'merchant_card' | 'platform_line';

export async function recordNumberFunding(env: Pick<Env, 'DB'>, phoneNumberId: string, funding: NumberFunding, now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, ?)').bind(phoneNumberId, funding, now).run();
}

/** For a batch with the phone_numbers insert, so the number and its funding appear together. */
export const fundingStatement = (db: D1Database, phoneNumberId: string, funding: NumberFunding, now = Date.now()) =>
  db.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, ?)').bind(phoneNumberId, funding, now);

export type OwnFundingResult = 'ok' | 'not_found' | 'operator_funded';

/** What a merchant sees before choosing: the number must be one of THEIR OWN (never a shared line), and the answer says who pays now. */
export async function ownNumberFunding(env: Pick<Env, 'DB'>, workspaceId: string, phoneNumberId: string): Promise<{ phoneNumberId: string; current: NumberFunding | 'unknown' } | null> {
  const n = await env.DB.prepare('SELECT pn.phone_number_id, nf.funding FROM phone_numbers pn LEFT JOIN number_funding nf ON nf.phone_number_id = pn.phone_number_id WHERE pn.phone_number_id = ? AND pn.workspace_id = ?')
    .bind(phoneNumberId, workspaceId).first<{ phone_number_id: string; funding: NumberFunding | null }>();
  return n ? { phoneNumberId: n.phone_number_id, current: n.funding ?? 'unknown' } : null;
}

/**
 * A merchant's choice for an OWN number: Meta bills the card on their Meta account ('merchant_card', the only value a merchant may set). The platform line stays an
 * operator decision (a merchant never reaches it; the route refuses the value before this runs), and a number the operator put on the platform line is not taken back
 * by the merchant: one conditional upsert, so a race with an operator write cannot be overwritten. The owning workspace's pricing copy is refreshed at once.
 */
export async function setOwnNumberCard(env: Env, a: { workspaceId: string; phoneNumberId: string; actor: string }, now = Date.now()): Promise<OwnFundingResult> {
  const own = await ownNumberFunding(env, a.workspaceId, a.phoneNumberId);
  if (!own) return 'not_found';
  const r = await env.DB.prepare("INSERT INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'merchant_card', ?) ON CONFLICT(phone_number_id) DO UPDATE SET funding = 'merchant_card', updated_at = excluded.updated_at WHERE number_funding.funding != 'platform_line'")
    .bind(a.phoneNumberId, now).run();
  if (r.meta.changes !== 1) return 'operator_funded';
  await billingAudit(env, { actor: a.actor, action: 'number_funding_set_by_merchant', workspaceId: a.workspaceId, before: { phoneNumberId: a.phoneNumberId, funding: own.current }, after: { phoneNumberId: a.phoneNumberId, funding: 'merchant_card' }, at: now });
  await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.workspaceId)).refreshPricing(); // never-stale money state: not at the next 30-minute pull
  return 'ok';
}
