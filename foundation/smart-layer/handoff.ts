/** Handoff rules and the weekly unanswered report (plan 4 Task A11, ruling SL-HANDOFF-1). Pure functions; the adapter delivers the packet. */
import { foldArabic } from '../text';
import { francoToArabic } from './rails/franco';
import type { AuditRow, HandoffPacket } from './types';

const view = (t: string): string => `${foldArabic(t)} | ${foldArabic(francoToArabic(t))}`;
const ASKED = /عايز\s+(?:اكلم|اتكلم|كلم)\s*(?:حد|انسان|موظف)|كلمني\s+(?:حد|موظف)|كلموني|اكلم\s+(?:حد|موظف|الدعم)|الدعم\s+(?:الفني|البشري)|\b(?:human|agent|support|real\s+person|representative)\b|\bakalem\s+7?ad\b|\bakalm\s+(?:7ad|had)\b|\bkalemny\b/;
const FRUSTRATED = /زهقت|مش\s+بتفهم|مش\s+فاهم\s+حاجه|انت\s+(?:غبي|وحش)|بوت\s+(?:غبي|وحش)|مش\s+شغال\s+خالص|ملعون|\b(?:useless|stupid\s+bot|this\s+is\s+(?:not\s+working|terrible)|waste\s+of\s+time)\b/;

export function handoffReason(s: { notCoveredStreak: number; failedTools: number; text: string; forbiddenHit: boolean }): HandoffPacket['reason'] | null {
  const v = view(s.text);
  if (ASKED.test(v)) return 'asked_human';
  if (s.forbiddenHit) return 'forbidden';
  if (FRUSTRATED.test(v)) return 'frustration';
  if (s.failedTools >= 2) return 'repeated_failure';
  if (s.notCoveredStreak >= 2) return 'low_confidence';
  return null;
}

/** The questions the corpus could not answer, most frequent first (masked prompts only; grouped after folding). */
export function summariseUnanswered(rows: AuditRow[]): Array<{ question: string; count: number }> {
  const groups = new Map<string, { question: string; count: number }>();
  for (const r of rows) {
    if (r.outcome !== 'not_covered') continue;
    const key = foldArabic(r.maskedPrompt);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { question: r.maskedPrompt, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.question.localeCompare(b.question));
}
