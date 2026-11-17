/** Approval issuing, split out of approval.ts so journal.ts (undo of a confirm-class inverse) can issue without an import cycle. */
import { sha256Hex } from '../release';
import type { ApprovalRecord, PreviewRecord, SmartLayerAdapter, TurnCtx } from '../types';

export const APPROVAL_TTL_MS = 15 * 60 * 1000;
export type ApprovalToken = { approvalId: string; previewId: string; token: string };
export type ApprovalDeps = { onApprovalToken?: (t: ApprovalToken) => void };

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function issueApproval(a: SmartLayerAdapter, ctx: TurnCtx, preview: PreviewRecord): Promise<{ approvalId: string; token: string }> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  const token = b64url(raw);
  const rec: ApprovalRecord = {
    id: crypto.randomUUID(), storeId: ctx.storeId, userId: ctx.userId, previewId: preview.id,
    tokenHash: await sha256Hex(token), payloadHash: preview.payloadHash, expiresAt: ctx.now + APPROVAL_TTL_MS, status: 'pending', createdAt: ctx.now,
  };
  await a.storage.putApproval(rec);
  return { approvalId: rec.id, token };
}
