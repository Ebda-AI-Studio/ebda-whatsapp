/**
 * Arabic + English text folding, TWO folds (Ruling F7-HAMZA-2, supersedes F7-HAMZA-1). A query matches a term when the two agree under fold B OR under fold A.
 * FOLD B (`foldArabic`, `indexTokens`, `searchTokens`) is the original Store fold, byte for byte (Ruling FDN-TEXT-1): every equivalence it ever made still holds (`vectors/arabic.json` is the no-regression set). Its SQL twin `ebda_ar_norm` is unchanged.
 * FOLD A (`foldArabicHamza`, below) is the hamza fold: NFKC first, ء ئ ؤ all become و and a run of و collapses, so `مسئول` = `مسؤول`, `سؤال` = `سوال` = `سئوال`, `سائل` = `ساءل` (not `سال`).
 * Why two and not one: typed `ي` for `ئ` (`سايل`, `رايع`) is B's equivalence; seat variants are A's; no single fold has both, because merging them makes `مسيول` = `مسئول` = `مسؤول` = `مسوول`, which is wrong for each product's users.
 * Fold B, original header: Deliberately NO Unicode
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
// Linear trim, not /^ +| +$/g: the trailing ` +$` alternative is polynomial on a long run of spaces (CodeQL js/polynomial-redos).
function trimEdgeSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a++;
  while (b > a && s.charCodeAt(b - 1) === 32) b--;
  return s.slice(a, b);
}

export function foldArabic(input: string): string {
  if (!input) return '';
  const stripped = input.replace(STRIP, '');
  let out = '';
  for (const ch of stripped) out += FOLD.get(ch) ?? ch;
  return trimEdgeSpaces(out.replace(SPACES, ' '));
}

/** `foldArabic`, then every run of non-letter, non-digit characters (punctuation, emoji) becomes one space. For building search-index text. */
export function indexTokens(input: string): string {
  return trimEdgeSpaces(foldArabic(input).replace(/[^\p{L}\p{N}]+/gu, ' '));
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

// ---- fold A: hamza seats unified, NFKC first (Ruling F7-HAMZA-2) --------------------------------------------------------------------------
// Steps, in order: NFKC (pasted lam-alef ligature, Arabic presentation forms, fullwidth digits/letters, no-break and ideographic spaces become the
// typed letters); delete tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640; the B table, except that ء U+0621, ئ U+0626 and ؤ U+0624
// ALL become و; a run of و collapses to one و (so a hamza seat beside a real و meets the plain spelling); whitespace as in B.
// SQL twin: `ebda_ar_norm_h` (Store migration 20261123000100_search_fold_hamza) does the same steps in the same order.
const STRIP_H = /[\u064B-\u065F\u0670\u0640]/g;
const WAWS = /و{2,}/g;
/** Fold A's translate table, the SQL twin's `translate(x, FROM, TO)` strings byte for byte: B's table with ئ -> و instead of ي, plus ء -> و (ؤ is already -> و). */
export const AR_FOLD_H_FROM = AR_FOLD_FROM + 'ء';
export const AR_FOLD_H_TO = [...AR_FOLD_TO].map((c, i) => (i === [...AR_FOLD_FROM].indexOf('ئ') ? 'و' : c)).join('') + 'و';
const FOLD_H = new Map<string, string>();
{
  const from = [...AR_FOLD_H_FROM];
  const to = [...AR_FOLD_H_TO];
  from.forEach((c, i) => FOLD_H.set(c, to[i]!));
}
/** The hamza fold of `input` (fold A). Use it beside `foldArabic` (fold B), never instead of it: see the header. */
export function foldArabicHamza(input: string): string {
  if (!input) return '';
  const stripped = input.normalize('NFKC').replace(STRIP_H, '');
  let out = '';
  for (const ch of stripped) out += FOLD_H.get(ch) ?? ch;
  return trimEdgeSpaces(out.replace(WAWS, 'و').replace(SPACES, ' '));
}
/** `indexTokens` under fold A. */
export function indexTokensHamza(input: string): string {
  return trimEdgeSpaces(foldArabicHamza(input).replace(/[^\p{L}\p{N}]+/gu, ' '));
}
/** `searchTokens` under fold A. */
export function searchTokensHamza(input: string, max = 8): string[] {
  return foldArabicHamza(input ?? '').split(' ').filter(Boolean).slice(0, max);
}
/**
 * Index text for a store that keeps ONE text per row and matches per word (Chat's FTS5): the B tokens, then the A tokens when they differ.
 * Query each typed word as `"<b>"* OR "<a>"*` (see `searchWordPairs`).
 */
export function indexTextBoth(input: string): string {
  const b = indexTokens(input);
  const a = indexTokensHamza(input);
  return a === b ? b : `${b} ${a}`;
}
/** Each typed word as its fold-B and fold-A form (equal forms collapse to one, and that one is tried against BOTH index texts): at most `max` words. `سائل` gives `['سايل', 'ساول']`. */
export function searchWordPairs(input: string, max = 8): string[][] {
  const b = searchTokens(input, max);
  const a = searchTokensHamza(input, max);
  // NFKC can split a word that fold B keeps whole (a thin space inside it): the counts differ, so use A alone (it is NFKC'd).
  if (a.length !== b.length) return a.map((t) => [t]);
  return b.map((t, i) => (a[i] === undefined || a[i] === t ? [t] : [t, a[i]!]));
}
/** Do two terms agree under fold B OR under fold A? (Ruling F7-HAMZA-2.) Not transitive on purpose. */
export function sameSearchTerm(a: string, b: string): boolean {
  return foldArabic(a) === foldArabic(b) || foldArabicHamza(a) === foldArabicHamza(b);
}
