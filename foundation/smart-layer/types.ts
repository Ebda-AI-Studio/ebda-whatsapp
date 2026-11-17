/** Shared types of the Smart Layer engine (plan 4 Task A1). Pure types: no runtime code, no deps, no node: imports. */
import type { AiBinding } from './provider';
import type { ModelRouting } from './models';

export type Policy = 'free' | 'preview' | 'confirm' | 'forbidden';
export type UndoClass = 'none' | 'reversible' | 'compensating' | 'irreversible';
export type Mode = 'off' | 'answer-only' | 'suggest' | 'act';
export type Locale = 'ar' | 'en';

export interface SchemaLike<T> {
  safeParse(x: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
}

export interface TurnCtx {
  product: 'store' | 'chat';
  storeId: string;
  userId: string;
  role: string;
  locale: Locale;
  now: number;
  conversationId: string;
  releaseId: string;
}

export interface RefCheck { kind: string; id: string }
export interface PreviewRow { label: { ar: string; en: string }; before?: unknown; after?: unknown; source?: 'merchant' | 'untrusted' }
export interface PreviewDraft {
  summary: { ar: string; en: string };
  rows: PreviewRow[];
  affectedCount: number;
  etag: string;
  payload: unknown;
  touchesCheckout?: boolean;
  changesPrice?: boolean;
  costCredits?: number;
}
export interface AppliedResult { ok: true; etagAfter: string; result?: unknown }
export interface InverseOp { tool: string; args: unknown }

export interface ToolSpec<A = unknown> {
  name: string;
  capabilityId: string;
  description: string;
  args: SchemaLike<A>;
  jsonSchema: Record<string, unknown>;
  policy: Exclude<Policy, 'forbidden'>;
  undo: UndoClass;
  money?: boolean;
  deletes?: boolean;
  messagesCustomers?: boolean;
  resultTrust: 'typed-source' | 'store-data' | 'untrusted';
  refs?(args: A): RefCheck[];
  read?(ctx: TurnCtx, args: A): Promise<unknown>;
  preview?(ctx: TurnCtx, args: A): Promise<PreviewDraft>;
  apply?(ctx: TurnCtx, args: A, draft: PreviewDraft): Promise<AppliedResult>;
  inverse?(ctx: TurnCtx, args: A, draft: PreviewDraft, applied: AppliedResult): InverseOp | null;
}

export interface RegistryCap {
  id: string;
  version: number;
  status: 'live' | 'in-pr' | 'planned';
  policy: Policy;
  undo: UndoClass | 'unclassified';
  title: { ar: string; en: string };
  appPaths: string[];
  uiLabels: { ar: string[]; en: string[] };
  helpArticle: string | null;
  examples: string[];
  area: string;
}
export interface RegistryView { caps: ReadonlyMap<string, RegistryCap>; byAppPath(path: string): RegistryCap | undefined }

export interface HelpHit { articleId: string; title: string; url: string; appPath: string | null; text: string; score: number }
export interface BindingSource { kind: 'plan' | 'limit' | 'billing' | 'legal' | 'setting'; key: string; text: { ar: string; en: string }; values: string[] }
export interface Controls { mode: Mode; killGlobal: boolean; killProduct: boolean; killedTools: ReadonlySet<string>; shadow: boolean }
export interface HandoffPacket { reason: 'low_confidence' | 'repeated_failure' | 'frustration' | 'forbidden' | 'asked_human'; maskedTranscript: string; journalIds: string[] }

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'cap'; capabilityId: string; label: string; appPath: string }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'cite'; articleId: string; title: string; url: string };

export type TurnStatus = 'answered' | 'refused' | 'not_covered' | 'handoff' | 'off' | 'limited';

export interface PreviewCard {
  previewId: string;
  summary: { ar: string; en: string };
  rows: PreviewRow[];
  policy: 'preview' | 'confirm';
  reasons: string[];
  undo: UndoClass;
  costCredits?: number;
  /** Filled for a confirm-class preview. The id only: the token goes to the HTTP layer, never into a card, a row or a prompt. */
  approvalId?: string;
}

export interface TurnResult {
  status: TurnStatus;
  segments: Segment[];
  previews: PreviewCard[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
  turnId: string;
}

export interface TurnRow { id: string; storeId: string; conversationId: string; userId: string; role: 'merchant' | 'assistant'; maskedText: string; at: number; releaseId: string }
export interface AuditRow {
  id: string; storeId: string; userId: string; turnId: string; at: number; releaseId: string;
  maskedPrompt: string; maskedOutput: string; rails: Record<string, number | string>;
  toolsOffered: string[]; toolCalls: string[]; previewId?: string; decision?: string;
  outcome: TurnStatus; inputTokens: number; outputTokens: number; model: string;
}
export interface PreviewRecord {
  id: string; storeId: string; userId: string; turnId: string; tool: string; args: unknown; draft: PreviewDraft;
  policy: 'preview' | 'confirm'; reasons: string[]; undo: UndoClass; payloadHash: string; createdAt: number; releaseId: string;
  status: 'open' | 'applying' | 'applied' | 'superseded' | 'expired';
}
export interface AppliedRecord { id: string; storeId: string; previewId: string; userId: string; tool: string; inverse: InverseOp | null; undo: UndoClass; etagAfter: string; appliedAt: number; undoneAt?: number }
export interface ApprovalRecord { id: string; storeId: string; userId: string; previewId: string; tokenHash: string; payloadHash: string; expiresAt: number; status: 'pending' | 'used' | 'rejected' | 'expired'; createdAt: number }
export interface DecisionRow { approvalId: string; storeId: string; decider: string; decision: 'confirmed' | 'rejected' | 'expired' | 'rejected:permission' | 'rejected:stale'; reason?: string; at: number }

export interface SmartLayerStorage {
  appendTurn(r: TurnRow): Promise<void>;
  loadTurns(storeId: string, conversationId: string, limit: number): Promise<TurnRow[]>;
  appendAudit(r: AuditRow): Promise<void>;
  putPreview(r: PreviewRecord): Promise<void>;
  getPreview(storeId: string, id: string): Promise<PreviewRecord | null>;
  /** Atomic compare-and-set (SQL: UPDATE .. WHERE status = from). Resolves true only for the caller that made the change. */
  transitionPreview(storeId: string, id: string, from: PreviewRecord['status'], to: PreviewRecord['status']): Promise<boolean>;
  putApplied(r: AppliedRecord): Promise<void>;
  getApplied(storeId: string, id: string): Promise<AppliedRecord | null>;
  /** Atomic compare-and-set: resolves true only for the single caller that moved the record from not-undone to undone. */
  markUndone(storeId: string, id: string, now: number): Promise<boolean>;
  /** Atomic inverse of markUndone (rolls the claim back when the inverse failed): true only if it was undone. */
  unmarkUndone(storeId: string, id: string): Promise<boolean>;
  putApproval(r: ApprovalRecord): Promise<void>;
  getApproval(storeId: string, id: string): Promise<ApprovalRecord | null>;
  /** CAS pending -> rejected | expired. */
  closeApproval(storeId: string, id: string, to: 'rejected' | 'expired'): Promise<boolean>;
  claimApproval(storeId: string, id: string, tokenHash: string, payloadHash: string, now: number): Promise<'claimed' | 'used' | 'expired' | 'mismatch' | 'missing'>;
  recordDecision(r: DecisionRow): Promise<void>;
  loadDecisions(storeId: string, approvalId: string): Promise<DecisionRow[]>;
  /** Audit rows of a store with `at >= sinceMs`, newest last, at most `limit` (weekly unanswered report, review, tests). */
  loadAudits(storeId: string, sinceMs: number, limit: number): Promise<AuditRow[]>;
  bump(key: string, windowMs: number, now: number): Promise<number>;
  /** Erasure and retention cover EVERY record type: turns, audits, previews (drafts hold before/after rows), applied, approvals, decisions. */
  eraseStore(storeId: string): Promise<void>;
  eraseUser(storeId: string, userId: string): Promise<void>;
  /** Deletes everything older than `cutoff` (by its own timestamp) and returns how many records went. */
  purgeBefore(cutoff: number): Promise<number>;
}

export interface SmartLayerAdapter {
  product: 'store' | 'chat';
  registry(): RegistryView;
  tools(): ToolSpec[];
  helpSearch(q: string, locale: Locale, k: number): Promise<HelpHit[]>;
  bindingSources(ctx: TurnCtx): Promise<BindingSource[]>;
  merchantDomains(ctx: TurnCtx): Promise<string[]>;
  controls(ctx: TurnCtx): Promise<Controls>;
  quota: {
    assertTurn(ctx: TurnCtx, heavyCredits?: number): Promise<void>;
    record(ctx: TurnCtx, u: { inputTokens: number; outputTokens: number; model: string; heavyCredits?: number }): Promise<void>;
  };
  checkRefs(ctx: TurnCtx, refs: RefCheck[]): Promise<{ missing: RefCheck[] }>;
  handoff(ctx: TurnCtx, p: HandoffPacket): Promise<void>;
  /** Capability id of the secure screen where the merchant enters a secret of this kind (a deep link, never typed in chat). */
  secureScreen?(kind: 'meta_token' | 'cf_token' | 'api_key' | 'password' | 'jwt' | 'card' | 'private_key'): string | null;
  ai: AiBinding;
  models: ModelRouting;
  storage: SmartLayerStorage;
}
