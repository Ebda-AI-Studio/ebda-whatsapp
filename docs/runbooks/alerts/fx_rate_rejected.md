# fx_rate_rejected (P1)
**Severity:** P1 look today
## What it means
Today's rate moved more than 5% from the newest stored rate, so it was NOT inserted. Fields: `source`, `observedMicros`, `lastMicros`, `movePct`. The observed value is recorded here, never silently dropped.
## Impact
The last rate stays in use. If the move is real (a devaluation), prices lag it and the buffer is all that protects the margin.
## Check first
Read the alert fields, then follow the steps under Fix.
## Fix
1. Compare `observedMicros` with a second source (central bank, `open.er-api.com`). 2. A bad feed: do nothing; tomorrow's run is measured against the same last rate. 3. A real move: publish it by hand with `POST /api/v1/operator/fx-rates` (>= 24 h ahead; a real devaluation deserves `bufferBps` 700) and pin the buffer with `PUT /api/v1/operator/fx-buffer-pin` if needed.
## Verify it is resolved
A row for the new rate exists, or the feed went back inside the band.
## Related
docs/billing.md#daily-fx-rate-wa-fx-daily-1, docs/plans/2026-11-12-daily-fx-rate.md
