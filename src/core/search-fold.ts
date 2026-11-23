import { indexTextBoth, searchWordPairs } from '../../foundation/text';
import { normaliseText } from './text-normalise';

/**
 * Which fold builds and queries the full-text indexes (`contacts_fts`, `messages_fts`) of ONE workspace (Ruling FDN-SEARCH-1,
 * docs/standard/arabic-search.md in the foundation). Index and query MUST use the same fold, so both read the same marker:
 * `store_state.search_fold` = 'v2' means the indexes were built with the shared foundation folds (`indexTextBoth`: fold B = the original Store fold,
 * then fold A = the hamza fold, Ruling F7-HAMZA-2) and a word matches under EITHER; no marker means the legacy `normaliseText`. The marker flips only inside `syncSearchFold`, in the same transaction as the
 * rebuild, so a workspace is never half-way.
 *
 * Driven by the platform flag `env.SEARCH_FOLD` ('v2' = on, anything else = off). OFF IS THE DEFAULT: nothing changes until it is set.
 */
export const SEARCH_FOLD_KEY = 'search_fold';
export const SEARCH_FOLD_V2 = 'v2';

export type Fold = (text: string) => string;

export function isSearchFoldV2(sql: SqlStorage): boolean {
  return sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', SEARCH_FOLD_KEY).toArray()[0]?.value === SEARCH_FOLD_V2;
}

/** The fold this workspace's index was built with. Bulk loops read it ONCE and pass it down (one SELECT per batch, not per row). */
export function searchFoldOf(sql: SqlStorage): Fold {
  return isSearchFoldV2(sql) ? indexTextBoth : normaliseText;
}

const MAX_WORDS = 8;
const MAX_ALTS = 2;
const MAX_TOKEN_LEN = 64;
const NON_WORD = /[^\p{L}\p{N}]+/gu;

/** Splits one folded form on anything that is not a letter or digit, exactly as the index side (`indexTokens`) does, so `أحمد,` meets the indexed `أحمد`. */
const wordsOf = (form: string): string[] => form.replace(NON_WORD, ' ').split(' ').filter(Boolean);

/** v2 words: every form is cut to letters/digits (index parity); alternatives that split into the same count stay paired, otherwise the first form alone is used. */
function v2Words(q: string): string[][] {
  const out: string[][] = [];
  for (const alts of searchWordPairs(q)) {
    const split = alts.map(wordsOf);
    const n = split[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const forms = split.every((w) => w.length === n) ? [...new Set(split.map((w) => w[i]!))] : [split[0]![i]!];
      out.push(forms);
    }
  }
  return out.slice(0, MAX_WORDS);
}

/**
 * The (at most 8) query words, each as its alternatives: ONE form under the legacy fold; under v2 the fold-B form and the fold-A form (one when
 * they agree). The index text holds both folds, so a word matches when ANY of its forms is a prefix of an indexed word.
 */
export function searchWords(sql: SqlStorage, q: string): string[][] {
  if (isSearchFoldV2(sql)) return v2Words(q);
  return normaliseText(q).split(' ').filter(Boolean).slice(0, MAX_WORDS).map((t) => [t]);
}

/** One FTS5 string: wrapped in double quotes with every inner `"` doubled, so no input can end the string or reach the FTS5 grammar (NEAR, AND, OR, `*`, `col:`). */
const ftsString = (t: string): string => `"${t.slice(0, MAX_TOKEN_LEN).replaceAll('"', '""')}"*`;

/**
 * The FTS5 MATCH expression of `searchWords`: `("b"* OR "a"*) AND "c"*`. Defence in depth, independent of how the words were produced: every form is
 * quoted with `"` doubled, empty forms and words are dropped, and the word / alternative / length counts are capped. Words with nothing left give '' (callers check `tokens.length` first, so
 * an all-punctuation query matches nothing instead of throwing).
 */
export function ftsMatch(words: string[][]): string {
  return words
    .map((alts) => alts.filter(Boolean).slice(0, MAX_ALTS).map(ftsString))
    .filter((alts) => alts.length > 0)
    .slice(0, MAX_WORDS)
    .map((alts) => (alts.length === 1 ? alts[0]! : `(${alts.join(' OR ')})`))
    .join(' AND ');
}

/**
 * Brings the workspace to the flag: when `wantV2` differs from the marker, `rebuild` runs (it re-indexes every name and message with
 * `searchFoldOf`) and the marker is written in the SAME transaction. Turning the flag off reverses it (marker deleted, legacy fold rebuilt).
 * Returns true when it rebuilt. The caller wraps this in `transactionSync`.
 */
export function syncSearchFold(sql: SqlStorage, wantV2: boolean, rebuild: () => void): boolean {
  if (isSearchFoldV2(sql) === wantV2) return false;
  if (wantV2) sql.exec('INSERT OR REPLACE INTO store_state (key, value) VALUES (?, ?)', SEARCH_FOLD_KEY, SEARCH_FOLD_V2);
  else sql.exec('DELETE FROM store_state WHERE key = ?', SEARCH_FOLD_KEY);
  rebuild();
  return true;
}
