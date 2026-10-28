import { normaliseText } from './text-normalise';

// Whole-message keywords only: "stop" or "cancel" inside a sentence must never opt anyone out ("cancel my order" is an order question).
// ONE vocabulary module, two sets, matched through normaliseText (case, diacritics, alef/yaa/taa forms, punctuation):
//  - BUTTON words: explicit opt-out phrases, safe for a tapped button / list row (title or id).
//  - TEXT words: the button words PLUS bare words that are an opt-out only when the customer TYPES them. A bare "Cancel" / "إلغاء" / "وقف"
//    on a button belongs to the merchant's own flow ("cancel appointment"); treating the tap as a STOP would silence the customer for all marketing.
export const OPT_OUT_BUTTON_WORDS: readonly string[] = [
  'stop', 'stop all', 'stop messages', 'stop promotions', 'unsubscribe', 'unsubscribe me', 'optout', 'opt out',
  'وقف الرسائل', 'الغاء الاشتراك', 'ايقاف الرسائل', 'بطل رسايل', 'مش عايز رسايل', 'مش عايز رسائل', 'لا تراسلني', 'متبعتليش رسايل',
];
export const OPT_OUT_TEXT_WORDS: readonly string[] = [
  ...OPT_OUT_BUTTON_WORDS,
  'cancel', 'remove me', 'إلغاء', 'وقف', 'توقف', 'ايقاف', 'بطل', 'بطلوا',
];
const OPT_OUT = new Set(OPT_OUT_TEXT_WORDS.map(normaliseText));
const OPT_OUT_BUTTON = new Set(OPT_OUT_BUTTON_WORDS.map(normaliseText));
/** Opt-in words every product shares; a product adds its own through config (see WorkspaceConfig.optInKeywords). */
export const CORE_OPT_IN_KEYWORDS: readonly string[] = ['start', 'اشترك'];

/** True when the WHOLE message (ignoring case, punctuation, emoji, diacritics, alef forms) is an opt-out keyword. */
export function detectOptOut(text: string): boolean {
  return OPT_OUT.has(normaliseText(text));
}

/** An inbound message that is an opt-out: a text, or a tapped button / list row whose title or id is an explicit opt-out phrase (never a bare cancel/إلغاء/وقف). COD answers and store picks are never one. */
export function detectOptOutMessage(m: { type: string; text?: string; reply?: { kind: string; id: string; title: string } }): boolean {
  if (m.type === 'text') return !!m.text && detectOptOut(m.text);
  if (m.type === 'interactive' && m.reply) {
    if (m.reply.id.startsWith('cod:') || m.reply.id.startsWith('shared:pick:')) return false;
    return OPT_OUT_BUTTON.has(normaliseText(m.reply.title)) || OPT_OUT_BUTTON.has(normaliseText(m.reply.id));
  }
  return false;
}

/** The opt-in keyword (as normalised) the WHOLE message is, or null. The proof of a consent stores this, never the customer's message. */
export function matchOptIn(text: string, extraKeywords: readonly string[] = []): string | null {
  const t = normaliseText(text);
  return t !== '' && [...CORE_OPT_IN_KEYWORDS, ...extraKeywords].some((k) => normaliseText(k) === t) ? t : null;
}

export function detectOptIn(text: string, extraKeywords: readonly string[] = []): boolean {
  return matchOptIn(text, extraKeywords) !== null;
}
