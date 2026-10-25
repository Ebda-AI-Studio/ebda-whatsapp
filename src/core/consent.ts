import { normaliseText } from './text-normalise';

// Whole-message keywords only: "stop" inside a sentence must never opt anyone out.
const OPT_OUT = new Set(['stop', 'unsubscribe', 'إلغاء', 'وقف', 'وقف الرسائل', 'الغاء الاشتراك'].map(normaliseText));
/** Opt-in words every product shares; a product adds its own through config (see WorkspaceConfig.optInKeywords). */
export const CORE_OPT_IN_KEYWORDS: readonly string[] = ['start', 'اشترك'];

/** True when the WHOLE message (ignoring case, punctuation, emoji, diacritics, alef forms) is an opt-out keyword. */
export function detectOptOut(text: string): boolean {
  return OPT_OUT.has(normaliseText(text));
}

export function detectOptIn(text: string, extraKeywords: readonly string[] = []): boolean {
  const t = normaliseText(text);
  return t !== '' && [...CORE_OPT_IN_KEYWORDS, ...extraKeywords].some((k) => normaliseText(k) === t);
}
