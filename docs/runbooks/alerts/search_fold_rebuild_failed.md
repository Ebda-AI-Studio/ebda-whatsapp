# search_fold_rebuild_failed (P1)
**Severity:** P1 look today
## What it means
A workspace Durable Object woke with the platform flag `SEARCH_FOLD` out of step with its search index and the re-index threw (`syncSearchFold` in `src/core/search-fold.ts`, called from the `WorkspaceDO` constructor). Fields: `workspace`, `error` (error class).
## Impact
None for availability: the transaction rolled back, so the marker and the old index are unchanged and search keeps working with the old fold. The workspace retries on its next wake (the alert repeats until it succeeds).
## Check first
1. Search the logs for `{"alert":"search_fold_rebuild_failed"...}`; note `workspace` and `error`.
2. One workspace or many? One large workspace points at size or time limits; all of them points at a code or flag problem.
## Fix
1. Unset `SEARCH_FOLD` to stop the retries (the marker is unchanged, so nothing else rebuilds).
2. Fix the cause, then set the flag again, one small workspace first.
## Verify it is resolved
No new `search_fold_rebuild_failed` line for the workspace after its next wake, and search finds a word that only the new fold matches.
## Related
docs/search-fold.md
