/**
 * Execution rail 9: durable approval object (plan 4 Task C1, spec 4). A confirm-class change needs the merchant to press the button
 * in the UI, which calls its own HTTP route (`confirmApproval`). The approval is server-issued, single-use, bound to the SHA-256 of the
 * exact previewed payload, and expires after 15 minutes. Only the token's HASH is stored. The token goes to the HTTP layer through the
 * `onApprovalToken` callback and never into a `TurnRow`, `AuditRow`, `PreviewCard`, tool result or `LlmRequest`: a typed "yes" cannot
 * satisfy it because nothing the model or the chat text carries can name it.
 */
import { canExecute } from '../controls';
import { maskText } from '../audit';
import { sha256Hex } from '../release';
import type { DecisionRow, PreviewCard, SmartLayerAdapter, TurnCtx } from '../types';
import { issueApproval, type ApprovalDeps } from './issue';
import { applyOpenPreview, cardOf, type ApplyOutcome } from './journal';

export { issueApproval, APPROVAL_TTL_MS, type ApprovalToken, type ApprovalDeps } from './issue';

export type ConfirmResult =
  | { status: 'applied'; appliedId: string }
  | { status: 'stale'; card: PreviewCard }
  | { status: 'used' | 'expired' | 'mismatch' | 'missing' | 'forbidden' | 'killed' | 'mode' | 'failed' };

const decide = (a: SmartLayerAdapter, ctx: TurnCtx, approvalId: string, decision: DecisionRow['decision'], reason?: string) =>
  a.storage.recordDecision({ approvalId, storeId: ctx.storeId, decider: ctx.userId, decision, ...(reason ? { reason: maskText(reason).slice(0, 200) } : {}), at: ctx.now });

export async function confirmApproval(a: SmartLayerAdapter, ctx: TurnCtx, approvalId: string, token: string, deps: ApprovalDeps = {}): Promise<ConfirmResult> {
  const rec = await a.storage.getApproval(ctx.storeId, approvalId);
  const pv = rec ? await a.storage.getPreview(ctx.storeId, rec.previewId) : null;
  const tool = pv ? a.tools().find((t) => t.name === pv.tool) : undefined;
  if (!rec || !pv || !tool) return { status: 'missing' };
  if (rec.userId !== ctx.userId) {
    await decide(a, ctx, approvalId, 'rejected:permission', 'different user');
    return { status: 'forbidden' };
  }
  const gate = canExecute(await a.controls(ctx), tool, 'apply'); // before the claim: a stopped tool must not burn the merchant's token
  if (gate !== 'ok') return { status: gate };

  const claim = await a.storage.claimApproval(ctx.storeId, approvalId, await sha256Hex(token), pv.payloadHash, ctx.now);
  if (claim === 'expired') {
    await decide(a, ctx, approvalId, 'expired');
    return { status: 'expired' };
  }
  if (claim !== 'claimed') return { status: claim };

  const out: ApplyOutcome = await applyOpenPreview(a, ctx, tool, pv);
  if (out.status === 'applied') {
    await decide(a, ctx, approvalId, 'confirmed');
    return { status: 'applied', appliedId: out.appliedId };
  }
  if (out.status === 'stale') {
    await decide(a, ctx, approvalId, 'rejected:stale');
    const fresh = await a.storage.getPreview(ctx.storeId, out.card.previewId);
    if (!fresh) return { status: 'failed' };
    const issued = await issueApproval(a, ctx, fresh);
    deps.onApprovalToken?.({ approvalId: issued.approvalId, previewId: fresh.id, token: issued.token });
    return { status: 'stale', card: cardOf(fresh, tool, issued.approvalId) };
  }
  if (out.status === 'forbidden') await decide(a, ctx, approvalId, 'rejected:permission', 'apply refused by the product authorization');
  if (out.status === 'failed') {
    // The token was claimed but nothing changed (the preview reopened): hand the merchant a fresh approval instead of a dead card.
    const reopened = await a.storage.getPreview(ctx.storeId, pv.id);
    if (reopened && reopened.status === 'open') {
      const issued = await issueApproval(a, ctx, reopened);
      deps.onApprovalToken?.({ approvalId: issued.approvalId, previewId: reopened.id, token: issued.token });
    }
  }
  if (out.status === 'not_found') return { status: 'used' };
  return { status: out.status };
}

export async function rejectApproval(a: SmartLayerAdapter, ctx: TurnCtx, approvalId: string, reason?: string): Promise<{ status: 'rejected' | 'not_pending' | 'missing' | 'forbidden' }> {
  const rec = await a.storage.getApproval(ctx.storeId, approvalId);
  if (!rec) return { status: 'missing' };
  if (rec.userId !== ctx.userId) return { status: 'forbidden' };
  if (!(await a.storage.closeApproval(ctx.storeId, approvalId, 'rejected'))) return { status: 'not_pending' };
  await decide(a, ctx, approvalId, 'rejected', reason);
  return { status: 'rejected' };
}
