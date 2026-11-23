# Search fold (flag `SEARCH_FOLD`)

Chat's contact-name and message search matches a typed query against `contacts_fts` / `messages_fts` through ONE fold, chosen per workspace:

| State | Fold | How a workspace gets there |
|---|---|---|
| default (no marker) | `normaliseText` (NFKC, Unicode lower-case, alef/yaa/taa-marbuta/digits folded; does NOT fold ئ ؤ ک ی) | nothing set |
| `store_state.search_fold = 'v2'` | the foundation's `indexTokens` (the Store's fold, Ruling FDN-SEARCH-1) | platform var `SEARCH_FOLD=v2`; on a workspace's next DO wake it writes the marker and rebuilds both indexes in ONE transaction |

Index writes and query words both read the marker (`src/core/search-fold.ts`), so they cannot disagree. Unset the var to roll back (the marker is deleted and the legacy fold rebuilt on the next wake). `normaliseText` keeps serving non-search matching (opt-out keywords, bot intents); only the search paths moved.

Behaviour changes with the flag ON (tested in `test/search-fold.test.ts`): finds that did not exist before: `سوال` finds `سؤال`; `كوتشي` finds `کوتشی`; `كوت` finds the Persian-spelled name. Finds that stop: text stored with a compatibility form (the lam-alef ligature U+FEFB, fullwidth digits) no longer meets the typed letters, because the shared fold has no NFKC (its Postgres twin cannot). FTS5's own tokenizer still ignores case and Latin diacritics.

The inbox search boxes use the foundation's `useLiveSearch` (via `web/src/lib/useTypeahead.ts`) and `highlightSegments` (via `web/src/lib/highlight.ts`): from 1 character, 150 ms, stale requests aborted. Highlighting now marks each query word wherever it occurs instead of the query as one phrase with spaces removed.
