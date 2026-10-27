# shared_sent_not_recorded (P0)
**Severity:** P0 wake someone now
## What it means
`afterSharedSend` (`src/core/shared/shared-number.ts`) writes the `shared_routes` and `shared_sent` rows in D1 after Meta accepted a send from the shared platform number. It tries 3 times; if all fail it raises this alert and never repeats the send. Fields: `workspace`, `attempts`, `error` (error class name only).
## Impact
That message was delivered, but its replies and Meta statuses may not route back to the store. A customer's reply could reach the wrong store or be dropped (consent and privacy risk).
## Check first
1. Search logs for `{"alert":"shared_sent_not_recorded"...}`; note `workspace` and `error`.
2. Check D1 health and recent errors with `npx wrangler tail`; read docs/shared-number.md (the `afterSharedSend` paragraph).
3. See whether more than one alert fired: that points to a D1 outage, not one message.
## Fix
1. The system does not backfill the missing rows and the send is not repeated.
2. If D1 was down, wait for recovery; later messages record normally.
3. Repairing the missed route or status mapping: Not documented in code: ask the engineer on call.
## Verify it is resolved
New shared-number sends from the workspace stop alerting, and a test reply routes to the right store.
## Related
docs/shared-number.md; docs/runbooks/alerts.md
