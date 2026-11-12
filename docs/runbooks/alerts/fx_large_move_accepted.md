# fx_large_move_accepted (P1)
**Severity:** P1 look today
## What it means
Today's rate moved more than 5% from the newest stored rate, and the other independent provider (fawazahmed0 vs open.er-api.com), also fresh, agreed within 1%. The rate was inserted automatically. Fields: `source`, `observedMicros`, `otherSource`, `otherMicros`, `lastMicros`, `movePct`.
## Impact
Prices follow a large EGP move from tomorrow (the row is effective 24 h ahead). The buffer for that row is 700 if the move was a one-day rise above 3%.
## Check first
Confirm the move against a third source (central bank rate, a bank quote). Two feeds can share an upstream.
## Fix
If the move is wrong: publish a correcting rate with `POST /api/v1/operator/fx-rates` (at least 24 h ahead, `bufferBps` required); rows are never edited. If it is real: nothing to do; consider `PUT /api/v1/operator/fx-buffer-pin` while the market is moving.
## Verify it is resolved
`GET /api/v1/operator/fx-rates` shows the row with its source and buffer mode.
## Related
fx_rate_rejected, fx_rate_stale, docs/billing.md#daily-fx-rate-wa-fx-daily-1
