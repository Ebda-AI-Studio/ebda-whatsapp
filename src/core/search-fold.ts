import { indexTokens } from '../../foundation/text';
import { normaliseText } from './text-normalise';

/**
 * Which fold builds and queries the full-text indexes (`contacts_fts`, `messages_fts`) of ONE workspace (Ruling FDN-SEARCH-1,
 * docs/standard/arabic-search.md in the foundation). Index and query MUST use the same fold, so both read the same marker:
 * `store_state.search_fold` = 'v2' means the indexes were built with the shared foundation fold (`indexTokens`: the Store's fold, which also
 * folds ئ ؤ ک ی); no marker means the legacy `normaliseText`. The marker flips only inside `syncSearchFold`, in the same transaction as the
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

/** The fold this workspace's index was built with. */
export function searchFoldOf(sql: SqlStorage): Fold {
  return isSearchFoldV2(sql) ? indexTokens : normaliseText;
}

/** The (at most 8) query words, folded exactly like the index: what `"<word>"*` is matched against. */
export function searchWords(sql: SqlStorage, q: string): string[] {
  return searchFoldOf(sql)(q).split(' ').filter(Boolean).slice(0, 8);
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
