/**
 * Public surface of the Smart Layer engine (plan 4). Adapters import from `@ebda/foundation/smart-layer`; see docs/smart-layer.md.
 * Rails and stages are also importable one by one from their files (the vendored copy keeps the directory layout).
 */
export * from './types';
export * from './models';
export * from './provider';
export { toRegistryView } from './registry-view';
export { runTurn, stripDoneClaims, MSG, NOT_COVERED_REPLY, type TurnDeps, type TurnInput } from './loop';
export { BUDGET, BudgetExceeded, TurnBudget, checkRate } from './plan/budget';
export { selectTools, MAX_TOOLS } from './plan/select-tools';
export { detectSecrets, type SecretKind } from './rails/secrets';
export { maskForModel, maskPhones } from './rails/mask';
export { francoToArabic } from './rails/franco';
export { scopeCheck, type ScopeVerdict, type Classify } from './rails/scope';
export { fence, containsUntrusted, FENCE_RULE, type FenceKind } from './rails/fence';
export { checkBindingClaims } from './rails/binding-claims';
export { renderReply } from './rails/ui-truth';
export { allowLinks, isAllowedUrl, EBDA_HOSTS } from './rails/links';
export { registerScore } from './rails/register';
export { validateCall } from './exec/validate';
export { effectivePolicy, effectiveUndo, strongerPolicy, strongerUndo, BULK_THRESHOLD } from './exec/policy';
export { applyPreview, undoApplied, createPreviewRecord, payloadHash, ToolForbidden, UNDO_WINDOW_MS, PREVIEW_TTL_MS } from './exec/journal';
export { issueApproval, confirmApproval, rejectApproval, APPROVAL_TTL_MS, type ApprovalToken } from './exec/approval';
export { buildAudit, maskText } from './audit';
export { computeReleaseId, buildSystemPrompt, canonicalJson, sha256Hex, PROMPT_VERSION } from './release';
export { helpDoc, chunkHelp, corpusHash, groundingVerdict } from './help';
export { handoffReason, summariseUnanswered } from './handoff';
export { resolveControls, canExecute, type RawControls } from './controls';
export { checkAdapterContract } from './eval/adapter-contract';
export { runSmartLayerStorageContract, type ContractHarness } from './eval/storage-contract';
export { passAtK, passHatK, passAt1 } from './eval/passk';
export { cohensKappa } from './eval/kappa';
export { releaseGate, SAFETY_CLASSES, type EvalSummary } from './eval/gate';
export { goldenFromRegistry, type GoldenTask } from './eval/types';
export { scriptedProvider, say, call } from './eval/scripted-provider';
// Test doubles stay out of the index (production bundles): import `smart-layer/eval/memory-storage` and `smart-layer/eval/fake-adapter` by path in adapter tests.
