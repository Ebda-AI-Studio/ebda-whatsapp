/**
 * Arabic + English text folding. Canonical source: the Store's `normalizeArabicSearch` (Ruling FDN-TEXT-1), extended by Ruling F7-HAMZA-1.
 * Deliberately NO locale lowercasing (ASCII A-Z only): Postgres cannot reproduce Unicode case mapping immutably. Unicode NFKC IS applied first
 * (`normalize(t, NFKC)` is IMMUTABLE in Postgres 13+, verified on 17.11), so pasted compatibility forms (lam-alef ligature U+FEFB, Arabic
 * presentation forms from PDFs, fullwidth digits and letters, no-break and ideographic spaces) meet the typed letters. The SQL twin
 * `ebda_ar_norm` MUST do the same steps in the same order (Store migration 20261123000100_search_fold_hamza).
 *
 * Steps, in order: NFKC; delete tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640 and the hamza on its own seat ء U+0621 and ئ U+0626;
 * map alef forms to ا, ى ی to ي, ؤ to و, ة to ه, Persian kaf to ك, ASCII upper to lower, Arabic-Indic and Persian digits to 0-9; collapse runs of و
 * to one و (so ؤ and a deleted hamza seat meet: مسئول = مسؤول, سؤال = سوال = سئوال); whitespace.
 *
 * Whitespace: only the explicit class [ \t\n\r ] collapses to one U+0020, and the edge trim removes ONLY U+0020 (SQL `btrim(x, ' ')`).
 * String#trim() is NOT used: it also strips U+2009, U+3000, U+FEFF (NFKC already turned U+2009 and U+3000 into U+0020).
 */
// alef forms -> ا ; ى ی -> ي ; ؤ -> و ; ة -> ه ; Persian kaf -> ك ; then ASCII upper, then digits. (ئ and ء are not mapped: they are deleted.)
export const AR_FOLD_FROM = 'أإآٱىیؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
export const AR_FOLD_TO = 'ااااييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789';

const FOLD = new Map<string, string>();
{
  const from = [...AR_FOLD_FROM];
  const to = [...AR_FOLD_TO];
  from.forEach((c, i) => FOLD.set(c, to[i]!));
}

// tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640, hamza U+0621, yeh-with-hamza U+0626
const STRIP = /[ً-ٰٟـءئ]/g;
const WAWS = /و{2,}/g;
// explicit set (NOT \s): Postgres' [[:space:]] is locale-dependent
const SPACES = /[ \t\n\r ]+/g;
const EDGE_SPACE = /^ +| +$/g;

export function foldArabic(input: string): string {
  if (!input) return '';
  const stripped = input.normalize('NFKC').replace(STRIP, '');
  let out = '';
  for (const ch of stripped) out += FOLD.get(ch) ?? ch;
  return out.replace(WAWS, 'و').replace(SPACES, ' ').replace(EDGE_SPACE, '');
}

/** `foldArabic`, then every run of non-letter, non-digit characters (punctuation, emoji) becomes one space. For building search-index text. */
export function indexTokens(input: string): string {
  return foldArabic(input).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(EDGE_SPACE, '');
}

/** Digits only, with Arabic-Indic and Persian digits folded to 0-9: what a typed phone number is compared as against a stored number. */
export function phoneDigits(s: string): string {
  return foldArabic(s).replace(/\D+/g, '');
}

/** The words of a typed query after the fold: at most `max` (default 8), none empty. Store search and every product's typeahead split a query this way. */
export function searchTokens(input: string, max = 8): string[] {
  return foldArabic(input ?? '').split(' ').filter(Boolean).slice(0, max);
}

/** Escape a token for a SQL LIKE pattern with the default `\` escape. */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (m) => `\\${m}`);
}
