# fx_rate_rejected (P1)
**Severity:** P1 look today
## What it means
Today's rate moved more than 5% from the newest stored rate and the other independent provider did NOT confirm it (missing, frozen, or more than 1% apart), so it was not inserted. Fields: `source`, `observedMicros`, `lastMicros`, `movePct`, `otherSource`, `otherMicros` (null = the second source gave nothing usable). The observed value is recorded here, never silently dropped.
## Impact
The last rate stays in use. If the move is real, prices lag it and the buffer is all that protects the margin.
## Check first
Compare `observedMicros` and `otherMicros` with a third source (central bank rate, a bank quote).
## Fix
1. A bad feed: do nothing; tomorrow's run is measured against the same last rate.
2. A real devaluation the second source simply missed: publish it by hand with `POST /api/v1/operator/fx-rates` (at least 24 h ahead, `bufferBps` is required, use 700), and pin the buffer with `PUT /api/v1/operator/fx-buffer-pin` if needed.
## Verify it is resolved
A row for the new rate exists (`GET /api/v1/operator/fx-rates`), or the feed went back inside the band.
## Related
fx_large_move_accepted, fx_rate_stale, docs/billing.md#daily-fx-rate-wa-fx-daily-1
