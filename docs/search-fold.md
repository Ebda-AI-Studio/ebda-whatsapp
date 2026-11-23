# Search fold (flag `SEARCH_FOLD`)

Chat's contact-name and message search matches a typed query against `contacts_fts` / `messages_fts` through ONE fold, chosen per workspace:

| State | Fold | How a workspace gets there |
|---|---|---|
| default (no marker) | `normaliseText` (NFKC, Unicode lower-case, alef/yaa/taa-marbuta/digits folded; does NOT fold ئ ؤ ک ی) | nothing set |
| `store_state.search_fold = 'v2'` | TWO foundation folds, matched with OR (Ruling F7-HAMZA-2): fold B (the original Store fold) and fold A (hamza fold: NFKC first, ء ئ ؤ all become و, و runs collapse). The index text holds B tokens then A tokens; a word matches when either of its two forms is a prefix | platform var `SEARCH_FOLD=v2`; on a workspace's next DO wake it writes the marker and rebuilds both indexes in ONE transaction |

Index writes and query words both read the marker (`src/core/search-fold.ts`), so they cannot disagree. Unset the var to roll back (the marker is deleted and the legacy fold rebuilt on the next wake). `normaliseText` keeps serving non-search matching (opt-out keywords, bot intents); only the search paths moved.

Behaviour changes with the flag ON (tested in `test/search-fold.test.ts`), Ruling F7-HAMZA-2: finds that did not exist before: `مسؤول` finds `مسئول` and the reverse; `سوال`, `سؤال`, `سئوال` find each other; `سائل` finds `ساءل`; `حذاء` finds `حذائي`; `كوتشي` finds `کوتشی`; the same for message text. Finds that are KEPT: typed `ي` for `ئ` (`سايل` finds `سائل`, `رايع` finds `رائع`, `مسيول` finds `مسئول`) because fold B is the original fold; the match is not transitive (`مسيول` does not find `مسؤول`). Finds that stop: none for Arabic text; `سائل` does not find `سال` under either fold. The one-text index lets a fold-A form match inside the fold-B half of a row (a rare extra hit on a name or message), and index text roughly doubles for rows with a hamza seat.

The inbox search boxes use the foundation's `useLiveSearch` (via `web/src/lib/useTypeahead.ts`) and `highlightSegments` (via `web/src/lib/highlight.ts`): from 1 character, 150 ms, stale requests aborted. Highlighting now marks each query word wherever it occurs instead of the query as one phrase with spaces removed.
