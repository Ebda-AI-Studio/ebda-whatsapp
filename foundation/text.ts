/**
 * Arabic + English text folding. Canonical source: the Store's `normalizeArabicSearch` (Ruling FDN-TEXT-1). Deliberately NO Unicode
 * normalize() and NO locale lowercasing: Postgres cannot reproduce either immutably, so the SQL twin `ebda_ar_norm` would drift (Ruling SEARCH-2).
 *
 * Whitespace: only the explicit class [ \t\n\r ] collapses to one U+0020, and the edge trim removes ONLY U+0020 (SQL `btrim(x, ' ')`).
 * String#trim() is NOT used: it also strips U+2009, U+3000, U+FEFF.
 */
// alef forms -> ا ; ى ی ئ -> ي ; ؤ -> و ; ة -> ه ; Persian kaf -> ك ; then ASCII upper, then digits
export const AR_FOLD_FROM = 'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
export const AR_FOLD_TO = 'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789';

const FOLD = new Map<string, string>();
{
  const from = [...AR_FOLD_FROM];
  const to = [...AR_FOLD_TO];
  from.forEach((c, i) => FOLD.set(c, to[i]!));
}

// tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640
const STRIP = /[ً-ٰٟـ]/g;
// explicit set (NOT \s): Postgres' [[:space:]] is locale-dependent
const SPACES = /[ \t\n\r ]+/g;
const EDGE_SPACE = /^ +| +$/g;

export function foldArabic(input: string): string {
  if (!input) return '';
  const stripped = input.replace(STRIP, '');
  let out = '';
  for (const ch of stripped) out += FOLD.get(ch) ?? ch;
  return out.replace(SPACES, ' ').replace(EDGE_SPACE, '');
}

/** `foldArabic`, then every run of non-letter, non-digit characters (punctuation, emoji) becomes one space. For building search-index text. */
export function indexTokens(input: string): string {
  return foldArabic(input).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(EDGE_SPACE, '');
}

/** Digits only, with Arabic-Indic and Persian digits folded to 0-9: what a typed phone number is compared as against a stored number. */
export function phoneDigits(s: string): string {
  return foldArabic(s).replace(/\D+/g, '');
}
