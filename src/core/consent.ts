import { normaliseText } from './text-normalise';

// Whole-message keywords only: "stop" or "cancel" inside a sentence must never opt anyone out ("cancel my order" is an order question).
// ONE list for text and for button/list replies, matched through normaliseText (case, diacritics, alef/yaa/taa forms, punctuation).
const OPT_OUT_WORDS = [
  'stop', 'stop all', 'stop messages', 'unsubscribe', 'unsubscribe me', 'optout', 'opt out', 'cancel', 'remove me',
  'إلغاء', 'وقف', 'وقف الرسائل', 'الغاء الاشتراك', 'توقف', 'ايقاف', 'ايقاف الرسائل', 'بطل', 'بطلوا', 'بطل رسايل',
  'مش عايز رسايل', 'مش عايز رسائل', 'لا تراسلني', 'متبعتليش رسايل',
];
const OPT_OUT = new Set(OPT_OUT_WORDS.map(normaliseText));
/** Opt-in words every product shares; a product adds its own through config (see WorkspaceConfig.optInKeywords). */
export const CORE_OPT_IN_KEYWORDS: readonly string[] = ['start', 'اشترك'];

/** True when the WHOLE message (ignoring case, punctuation, emoji, diacritics, alef forms) is an opt-out keyword. */
export function detectOptOut(text: string): boolean {
  return OPT_OUT.has(normaliseText(text));
}

/** An inbound message that is an opt-out: a text, or a tapped button / list row whose title or id is an opt-out word. COD answers and store picks are never one. */
export function detectOptOutMessage(m: { type: string; text?: string; reply?: { kind: string; id: string; title: string } }): boolean {
  if (m.type === 'text') return !!m.text && detectOptOut(m.text);
  if (m.type === 'interactive' && m.reply) {
    if (m.reply.id.startsWith('cod:') || m.reply.id.startsWith('shared:pick:')) return false;
    return detectOptOut(m.reply.title) || detectOptOut(m.reply.id);
  }
  return false;
}

export function detectOptIn(text: string, extraKeywords: readonly string[] = []): boolean {
  const t = normaliseText(text);
  return t !== '' && [...CORE_OPT_IN_KEYWORDS, ...extraKeywords].some((k) => normaliseText(k) === t);
}
