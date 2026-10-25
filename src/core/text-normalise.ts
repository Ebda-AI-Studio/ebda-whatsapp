const TASHKEEL_AND_TATWEEL = /[ً-ٰٟـ]/g;
const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const ARABIC_FOLDS: Record<string, string> = { أ: 'ا', إ: 'ا', آ: 'ا', ٱ: 'ا', ى: 'ي', ة: 'ه' };

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
    .replace(/[٠-٩]/g, (d) => String(EASTERN_DIGITS.indexOf(d)))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
