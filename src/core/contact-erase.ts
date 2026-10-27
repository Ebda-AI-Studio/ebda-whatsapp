import type { Env } from '../env';
import { buyerKey } from './buyer-key';
import { completeErasure, recordErasure } from './erasure';
import { normaliseE164 } from './phone';

/**
 * Erases one contact from a workspace: the erasure RECORD first (D1, so a restore from an older backup drops this person), then the Durable Object's delete, then the
 * record's completion stamp. The ONE implementation behind the owner's `DELETE /stores/:id/contacts/:waId` and the operator's `DELETE /operator/workspaces/:id/contacts/:waId`.
 */
export type EraseOutcome = { status: 200; body: Record<string, unknown> } | { status: 400 | 404; body: { error: string } };
export async function eraseContactFlow(env: Env, a: { storeId: string; waIdParam: string; actor: string }): Promise<EraseOutcome> {
  const e164 = normaliseE164(a.waIdParam);
  if (!e164) return { status: 400, body: { error: 'invalid phone number' } };
  // The workspace id is the store id (Phase 1 ruling). Never touch a DO for an unregistered workspace.
  const known = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(a.storeId).first();
  if (!known) return { status: 404, body: { error: 'workspace not found' } };
  await recordErasure(env, { workspaceId: a.storeId, waId: e164.slice(1), actor: a.actor });
  const result = await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(a.storeId)).eraseContact(e164.slice(1));
  await completeErasure(env, { workspaceId: a.storeId, waId: e164.slice(1), completedAt: result.completedAt }); // the Durable Object's clock at the end of the delete
  if (!result.found && result.r2Pending === 0) return { status: 404, body: { error: 'contact not found' } };
  const who = env.SUITE_BUYER_KEY_SECRET ? await buyerKey(env.SUITE_BUYER_KEY_SECRET, e164) : `…${e164.slice(-4)}`;
  console.log(JSON.stringify({ audit: 'contact_erased', storeId: a.storeId, by: a.actor, buyer: who, ...result }));
  const { completedAt: _done, ...out } = result; // the completion time is for the erasure record, not for the caller
  return { status: 200, body: out };
}
