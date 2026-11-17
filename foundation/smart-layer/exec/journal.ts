/**
 * Preview / apply / undo protocol and journal (plan 4 Task B3, spec 4). A write is never one step: `createPreviewRecord` runs the
 * tool's `preview` and the policy gate and stores what the merchant will see; `applyPreview` (preview class) or `confirmApproval`
 * (confirm class, approval.ts) runs `tool.apply` only after re-reading the controls, re-running the preview and finding the SAME etag
 * (a changed etag becomes a fresh preview, never a silent write). Apply is a compare-and-set claim, so a double press applies once.
 * Every apply journals the inverse the tool declared; `undoApplied` works for 24 h and also re-previews when the item changed since.
 */
import { canExecute } from '../controls';
import { canonicalJson, sha256Hex } from '../release';
import type { AppliedRecord, PreviewCard, PreviewDraft, PreviewRecord, RegistryCap, SmartLayerAdapter, ToolSpec, TurnCtx } from '../types';
import { issueApproval, type ApprovalDeps } from './issue';
import { effectivePolicy, effectiveUndo, strongerPolicy } from './policy';

export const UNDO_WINDOW_MS = 24 * 3600 * 1000;
/** A preview card left on screen this long is stale by default; the etag check is the real guard. */
export const PREVIEW_TTL_MS = 60 * 60 * 1000;

/** Thrown by an adapter's `apply` when the product's own authorization (role, MFA, plan gate) refuses the merchant. */
export class ToolForbidden extends Error {
  constructor() {
    super('tool forbidden');
    this.name = 'ToolForbidden';
  }
}

export async function payloadHash(tool: string, args: unknown, draft: PreviewDraft): Promise<string> {
  return sha256Hex(canonicalJson({ tool, args, etag: draft.etag, payload: draft.payload, rows: draft.rows, affectedCount: draft.affectedCount, summary: draft.summary, costCredits: draft.costCredits ?? null }));
}

const MIN_COPIED = 12;
/** Marks preview rows whose new text was copied from untrusted content this turn (the UI says where the text came from). */
export function labelUntrusted(draft: PreviewDraft, untrustedTexts: string[]): PreviewDraft {
  const bad = untrustedTexts.map((t) => t.trim()).filter((t) => t.length >= MIN_COPIED);
  if (!bad.length) return draft;
  const rows = draft.rows.map((r) => {
    const after = typeof r.after === 'string' ? r.after : '';
    const copied = after.length >= MIN_COPIED && bad.some((t) => after.includes(t) || t.includes(after));
    return copied ? { ...r, source: 'untrusted' as const } : r;
  });
  return { ...draft, rows };
}

export function cardOf(rec: PreviewRecord, _tool: Pick<ToolSpec, 'undo'>, approvalId?: string): PreviewCard {
  return {
    previewId: rec.id, summary: rec.draft.summary, rows: rec.draft.rows, policy: rec.policy, reasons: rec.reasons, undo: rec.undo,
    ...(rec.draft.costCredits !== undefined ? { costCredits: rec.draft.costCredits } : {}),
    ...(approvalId ? { approvalId } : {}),
  };
}

/** The registry entry a tool must be backed by: live, not forbidden. Anything else is not an action the assistant may build or apply. */
function liveCap(a: SmartLayerAdapter, tool: ToolSpec): RegistryCap | null {
  const cap = a.registry().caps.get(tool.capabilityId);
  return cap && cap.status === 'live' && cap.policy !== 'forbidden' ? cap : null;
}

export async function createPreviewRecord(a: SmartLayerAdapter, ctx: TurnCtx, tool: ToolSpec, args: unknown, turnId: string, o: { untrustedTexts?: string[] } = {}): Promise<{ record: PreviewRecord; card: PreviewCard }> {
  if (!tool.preview) throw new Error(`tool ${tool.name} has no preview`);
  const cap = liveCap(a, tool);
  if (!cap) throw new Error(`tool ${tool.name}: its capability is not live in the registry`);
  const draft = labelUntrusted(await tool.preview(ctx, args), o.untrustedTexts ?? []);
  const { policy, reasons } = effectivePolicy(tool, draft, { cap });
  const record: PreviewRecord = {
    id: crypto.randomUUID(), storeId: ctx.storeId, userId: ctx.userId, turnId, tool: tool.name, args, draft, policy, reasons, undo: effectiveUndo(tool, cap),
    payloadHash: await payloadHash(tool.name, args, draft), createdAt: ctx.now, releaseId: ctx.releaseId, status: 'open',
  };
  await a.storage.putPreview(record);
  return { record, card: cardOf(record, tool) };
}

export type ApplyOutcome =
  | { status: 'applied'; appliedId: string; undoUntil: number }
  | { status: 'stale'; card: PreviewCard }
  | { status: 'killed' | 'mode' | 'forbidden' | 'failed' | 'not_found' };

/** Shared by `applyPreview` and `confirmApproval`: controls, registry, fresh re-preview + etag/hash check, atomic claim, apply, journal. */
export async function applyOpenPreview(a: SmartLayerAdapter, ctx: TurnCtx, tool: ToolSpec, rec: PreviewRecord): Promise<ApplyOutcome> {
  const gate = canExecute(await a.controls(ctx), tool, 'apply'); // read at execution time: a switch flipped after the preview still stops it
  if (gate !== 'ok') return { status: gate };
  if (!liveCap(a, tool)) return { status: 'forbidden' }; // the registry changed since the preview: not live any more, or forbidden now
  let fresh: PreviewDraft;
  try {
    fresh = await tool.preview!(ctx, rec.args);
  } catch {
    return { status: 'failed' };
  }
  if (fresh.etag !== rec.draft.etag || (await payloadHash(tool.name, rec.args, fresh)) !== rec.payloadHash) {
    await a.storage.transitionPreview(ctx.storeId, rec.id, 'open', 'superseded');
    // keep the "copied from untrusted content" labels the first preview carried (they are not recomputable from the new rows alone)
    const carried = rec.draft.rows.filter((r) => r.source === 'untrusted' && typeof r.after === 'string').map((r) => r.after as string);
    const { card } = await createPreviewRecord(a, ctx, tool, rec.args, rec.turnId, { untrustedTexts: carried });
    return { status: 'stale', card };
  }
  if (!(await a.storage.transitionPreview(ctx.storeId, rec.id, 'open', 'applying'))) return { status: 'not_found' }; // lost the race: another press is applying it
  let applied;
  try {
    applied = await tool.apply!(ctx, rec.args, rec.draft);
  } catch (err) {
    await a.storage.transitionPreview(ctx.storeId, rec.id, 'applying', 'open');
    return { status: err instanceof ToolForbidden ? 'forbidden' : 'failed' };
  }
  const inverse = rec.undo === 'irreversible' || rec.undo === 'none' ? null : tool.inverse?.(ctx, rec.args, rec.draft, applied) ?? null;
  const row: AppliedRecord = { id: crypto.randomUUID(), storeId: ctx.storeId, previewId: rec.id, userId: ctx.userId, tool: tool.name, inverse, undo: rec.undo, etagAfter: applied.etagAfter, appliedAt: ctx.now };
  await a.storage.putApplied(row);
  await a.storage.transitionPreview(ctx.storeId, rec.id, 'applying', 'applied');
  return { status: 'applied', appliedId: row.id, undoUntil: ctx.now + UNDO_WINDOW_MS };
}

export type ApplyPreviewResult = ApplyOutcome | { status: 'needs_confirm' | 'expired' };

export async function applyPreview(a: SmartLayerAdapter, ctx: TurnCtx, previewId: string): Promise<ApplyPreviewResult> {
  const rec = await a.storage.getPreview(ctx.storeId, previewId);
  const tool = rec ? a.tools().find((t) => t.name === rec.tool) : undefined;
  if (!rec || !tool || rec.userId !== ctx.userId || rec.status !== 'open') return { status: 'not_found' };
  if (ctx.now - rec.createdAt > PREVIEW_TTL_MS) {
    await a.storage.transitionPreview(ctx.storeId, rec.id, 'open', 'expired');
    return { status: 'expired' };
  }
  // The stored policy AND the registry's current policy both bind: a confirm-class capability never applies without its approval object.
  const cap = liveCap(a, tool);
  if (!cap) return { status: 'forbidden' };
  if (rec.policy === 'confirm' || strongerPolicy(tool.policy, cap.policy) === 'confirm') return { status: 'needs_confirm' };
  return applyOpenPreview(a, ctx, tool, rec);
}

export type UndoResult =
  | { status: 'undone' }
  | { status: 'stale' | 'needs_confirm'; card: PreviewCard }
  | { status: 'expired' | 'irreversible' | 'not_found' | 'killed' | 'forbidden' | 'failed' };

/**
 * Undo is claimed (compare-and-set) BEFORE the inverse runs, so two presses apply it once; the claim is rolled back if the inverse
 * fails. The inverse is an action like any other: its capability must be live in the registry, and an inverse that lands on a DIFFERENT
 * tool (a compensating action) goes through the policy gate and, when that says confirm, becomes a card with its own approval.
 * Restoring the before-state through the SAME tool that made the change needs no new approval: that change already passed its gate.
 */
export async function undoApplied(a: SmartLayerAdapter, ctx: TurnCtx, appliedId: string, deps: ApprovalDeps = {}): Promise<UndoResult> {
  const rec = await a.storage.getApplied(ctx.storeId, appliedId);
  if (!rec || rec.userId !== ctx.userId || rec.undoneAt !== undefined) return { status: 'not_found' };
  if (!rec.inverse || rec.undo === 'irreversible' || rec.undo === 'none') return { status: 'irreversible' };
  if (ctx.now - rec.appliedAt > UNDO_WINDOW_MS) return { status: 'expired' };
  const inv = a.tools().find((t) => t.name === rec.inverse!.tool);
  if (!inv || !inv.preview || !inv.apply) return { status: 'not_found' };
  const c = await a.controls(ctx);
  if (c.killGlobal || c.killProduct || c.killedTools.has(inv.name)) return { status: 'killed' }; // undo ignores `mode`, never a kill switch
  const cap = liveCap(a, inv);
  if (!cap) return { status: 'forbidden' };
  const parsed = inv.args.safeParse(rec.inverse.args);
  if (!parsed.success) return { status: 'failed' };
  let draft: PreviewDraft;
  try {
    draft = await inv.preview(ctx, parsed.data);
  } catch {
    return { status: 'failed' };
  }
  if (draft.etag !== rec.etagAfter) {
    // The item changed after the assistant's change (the merchant edited it by hand): show what undo WOULD do, write nothing.
    const { card } = await createPreviewRecord(a, ctx, inv, parsed.data, 'undo');
    return { status: 'stale', card };
  }
  if (inv.name !== rec.tool && effectivePolicy(inv, draft, { cap }).policy === 'confirm') {
    const made = await createPreviewRecord(a, ctx, inv, parsed.data, 'undo');
    const issued = await issueApproval(a, ctx, made.record);
    deps.onApprovalToken?.({ approvalId: issued.approvalId, previewId: made.record.id, token: issued.token });
    return { status: 'needs_confirm', card: cardOf(made.record, inv, issued.approvalId) };
  }
  if (!(await a.storage.markUndone(ctx.storeId, appliedId, ctx.now))) return { status: 'not_found' }; // another press already claimed this undo
  try {
    await inv.apply(ctx, parsed.data, draft);
  } catch {
    await a.storage.unmarkUndone(ctx.storeId, appliedId);
    return { status: 'failed' };
  }
  return { status: 'undone' };
}
