/**
 * Execution rail 8: policy gate with big-change triggers (plan 4 Task B2, spec 4). A `preview` tool escalates to `confirm` when the
 * built preview says so: more than 20 affected items, anything visible at checkout, any price change, money / deletion / customer
 * messaging, an irreversible undo class. The engine trusts ONLY `draft.affectedCount` (computed by the adapter from real rows, with
 * Arabic-Indic digits folded), never a number in model text. A free tool never gets here; `forbidden` capabilities have no tool.
 *
 * The capability registry is the source of truth (spec 6.8): the effective policy is the STRICTER of the tool's declaration and the
 * registry entry's, and the effective undo class the harder-to-reverse of the two, so drift between them can only add a gate, never remove one.
 */
const RANK: Record<Policy, number> = { free: 0, preview: 1, confirm: 2, forbidden: 3 };
export const strongerPolicy = (a: Policy, b: Policy): Policy => (RANK[a] >= RANK[b] ? a : b);
const UNDO_RANK: Record<string, number> = { none: 0, reversible: 1, compensating: 2, irreversible: 3, unclassified: 3 };
/** Harder to reverse wins; a registry entry still `unclassified` is treated as irreversible (fail closed). */
export const strongerUndo = (a: UndoClass, b: UndoClass | 'unclassified'): UndoClass => {
  const hard = (UNDO_RANK[b] ?? 3) > (UNDO_RANK[a] ?? 3) ? b : a;
  return hard === 'unclassified' ? 'irreversible' : hard;
};
export const effectiveUndo = (tool: Pick<ToolSpec, 'undo'>, cap?: Pick<RegistryCap, 'undo'>): UndoClass => (cap ? strongerUndo(tool.undo, cap.undo) : tool.undo);
import type { Policy, PreviewDraft, RegistryCap, ToolSpec, UndoClass } from '../types';

export const BULK_THRESHOLD = 20;
export type PolicyReason = 'money' | 'delete' | 'customer_message' | 'bulk' | 'checkout' | 'price' | 'irreversible' | 'declared';

export function effectivePolicy(tool: ToolSpec, draft: PreviewDraft, o: { bulkThreshold?: number; cap?: Pick<RegistryCap, 'policy' | 'undo'> } = {}): { policy: 'preview' | 'confirm'; reasons: PolicyReason[] } {
  const declared = o.cap ? strongerPolicy(tool.policy, o.cap.policy) : tool.policy;
  if (declared === 'forbidden') throw new Error(`effectivePolicy: ${tool.name} is forbidden by the registry`);
  if ((tool.policy as string) === 'free' || (tool.policy as string) === 'forbidden') throw new Error(`effectivePolicy: ${tool.name} is ${tool.policy}, it has no preview/confirm gate`);
  const limit = o.bulkThreshold ?? BULK_THRESHOLD;
  const reasons: PolicyReason[] = [];
  if (declared === 'confirm') reasons.push('declared');
  if (tool.money) reasons.push('money');
  if (tool.deletes) reasons.push('delete');
  if (tool.messagesCustomers) reasons.push('customer_message');
  // A count that is not a non-negative integer is a bug upstream: fail toward the stronger gate.
  const n = draft.affectedCount;
  if (!Number.isInteger(n) || n < 0 || n > limit) reasons.push('bulk');
  if (draft.touchesCheckout) reasons.push('checkout');
  if (draft.changesPrice) reasons.push('price');
  if (effectiveUndo(tool, o.cap) === 'irreversible') reasons.push('irreversible');
  const order: PolicyReason[] = ['declared', 'money', 'delete', 'customer_message', 'bulk', 'checkout', 'price', 'irreversible'];
  reasons.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { policy: reasons.length ? 'confirm' : 'preview', reasons };
}
