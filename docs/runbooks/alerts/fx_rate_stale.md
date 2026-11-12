# fx_rate_stale (P1)
**Severity:** P1 look today
## What it means
The newest OBSERVED rate day (`obs_day`, the day the rate describes, not when a row was written) is more than 48 h old, or there is none. Fields: `newestObsDay`, `hours`. A frozen feed (payload dated before yesterday) counts as a failed fetch, so it ends here too.
## Impact
Prices run on an old rate. If EGP weakened meanwhile we under-charge by that drift (the buffer covers part of it).
## Check first
Read the alert fields, then follow the steps under Fix.
## Fix
1. Look for `fx_fetch_failed` / `fx_rate_rejected` in the last days: they are the cause. 2. Check the cron ran (`{"cron":"daily_billing","done":true}` in the logs, docs/runbooks/rollback.md). 3. Publish by hand with `POST /api/v1/operator/fx-rates` if the cause will not clear today. The check runs from `dailyBilling`, independent of the fetch job; if the whole cron is dead no alert fires, the missing `daily_billing` log line is the signal.
## Verify it is resolved
A new row, and no further `fx_rate_stale`.
## Related
docs/billing.md#daily-fx-rate-wa-fx-daily-1, docs/plans/2026-11-12-daily-fx-rate.md
