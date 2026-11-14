/**
 * Input rail 2: PII masking before any model sees buyer or merchant text (plan 4 Task A3). Moved from Ebda Chat
 * (`src/core/ai/mask.ts` + `maskPhones` in `src/core/observability.ts`) with identical behaviour; Chat re-exports this.
 * Phones, card-like numbers and e-mail addresses become placeholders; the stored message is untouched, only the copy sent to a model.
 */
const DIGIT = '[0-9\\u0660-\\u0669\\u06f0-\\u06f9]';
// A run of 8+ digits (ASCII, Arabic-Indic or Persian), optionally with +, spaces, dashes, dots or parentheses between them.
// Separators include Unicode format characters (\p{Cf}: bidi marks, zero-width joiners) so they cannot split a number past the mask.
const PHONE_LIKE = new RegExp(`\\+?${DIGIT}(?:[\\s\\-().\\p{Cf}]*${DIGIT}){7,}`, 'gu');
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
// 13 to 19 digits with at most one space or dash between digits (a card number, written plain or in groups of four).
const CARD = new RegExp(`(?<!${DIGIT})${DIGIT}(?:[ -]?${DIGIT}){12,18}(?!${DIGIT})`, 'gu');

export const maskPhones = (s: string): string => s.replace(PHONE_LIKE, '[phone]');

export function maskForModel(text: string): string {
  return maskPhones(text.replace(EMAIL, '[email]').replace(CARD, '[card]'));
}
