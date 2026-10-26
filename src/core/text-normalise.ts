const TASHKEEL_AND_TATWEEL = /[ً-ٰٟـ]/g;
const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_FOLDS: Record<string, string> = { أ: 'ا', إ: 'ا', آ: 'ا', ٱ: 'ا', ى: 'ي', ة: 'ه' };

function foldDigit(d: string): string {
  const i = EASTERN_DIGITS.indexOf(d);
  return String(i >= 0 ? i : PERSIAN_DIGITS.indexOf(d));
}

/**
 * One normaliser for matching free text (opt-out keywords) and for the search index, so a query and a stored
 * message always meet on the same form: lower-case, diacritics and tatweel removed, alef/yaa/taa-marbuta
 * variants folded, Arabic digits turned into 0-9, everything that is not a letter or digit (punctuation, emoji)
 * replaced by a single space.
 */
export function normaliseText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(TASHKEEL_AND_TATWEEL, '')
    .replace(/[أإآٱىة]/g, (c) => ARABIC_FOLDS[c]!)
    .replace(/[٠-٩۰-۹]/g, foldDigit)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Digits only, with Arabic-Indic (٠-٩) and Persian (۰-۹) digits folded to 0-9: what a typed phone number is compared as against `wa_id`. */
export function phoneDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, foldDigit).replace(/\D+/g, '');
}
