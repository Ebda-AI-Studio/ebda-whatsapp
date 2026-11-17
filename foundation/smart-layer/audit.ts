/**
 * Audit row builder (plan 4 Task A11, spec 6.9). Every text field is masked here AGAIN (phones, e-mails, cards, then secrets) so a
 * caller that forgot to mask upstream still cannot persist PII or a secret: defence in depth, not the primary control.
 */
import { detectSecrets } from './rails/secrets';
import { maskForModel } from './rails/mask';
import type { AuditRow, TurnStatus } from './types';

/** Hard cap on any stored text field: slice BEFORE the regex work so an oversized input cannot amplify storage or CPU. */
export const MAX_STORED_CHARS = 4000;
const clean = (s: string): string => maskForModel(detectSecrets(s.slice(0, MAX_STORED_CHARS)).text).slice(0, MAX_STORED_CHARS);

export interface AuditInput {
  storeId: string; userId: string; turnId: string; at: number; releaseId: string;
  prompt: string; output: string; rails: Record<string, number | string>;
  toolsOffered: string[]; toolCalls: string[]; previewId?: string; decision?: string;
  outcome: TurnStatus; inputTokens: number; outputTokens: number; model: string;
}

export function buildAudit(i: AuditInput): AuditRow {
  const rails: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(i.rails)) rails[k] = typeof v === 'string' ? clean(v) : v;
  return {
    id: crypto.randomUUID(),
    storeId: i.storeId, userId: i.userId, turnId: i.turnId, at: i.at, releaseId: i.releaseId,
    maskedPrompt: clean(i.prompt), maskedOutput: clean(i.output), rails,
    toolsOffered: i.toolsOffered, toolCalls: i.toolCalls,
    ...(i.previewId !== undefined ? { previewId: i.previewId } : {}),
    ...(i.decision !== undefined ? { decision: clean(i.decision) } : {}),
    outcome: i.outcome, inputTokens: i.inputTokens, outputTokens: i.outputTokens, model: i.model,
  };
}
export const maskText = clean;
