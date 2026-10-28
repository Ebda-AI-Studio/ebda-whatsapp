# rate_missing_estimate_charged (P1)
**Severity:** P1 look today
## What it means
A billed Meta message was delivered but no rate card row existed for it. After 7 days (`PENDING_RATE_MAX_MS`) the billing engine (src/core/billing/engine.ts) charged the held estimate as a `meta_charge` with the note "estimate: no rate published". Fields: `workspace`, `country`.
## Impact
Money may be slightly wrong: the merchant was charged the estimate, not Meta's real rate, for that message. It is never free.
## Check first
1. Search logs for `{"alert":"rate_missing_estimate_charged"` and note `country`.
2. List published rates: GET /api/v1/operator/rate-cards and GET /api/v1/operator/fx-rates.
3. Read docs/billing.md, "Money flow for a platform_line message", step "No rate found at delivery".
## Fix
1. Publish the missing rate: POST /api/v1/operator/rate-cards (must be effective at least 24 h ahead; format in docs/billing.md).
2. Reconcile the difference for the affected message using the documented adjustment route (POST /api/v1/operator/workspaces/:workspaceId/adjustments). Not documented in code: ask the engineer on call for how to price the correction.
3. The system does not true up the estimate by itself.
## Verify it is resolved
No new alerts for that country, and GET /api/v1/operator/workspaces/:workspaceId/wallet shows the corrected balance.
## Related
docs/billing.md ("Money flow"), alert: rate_missing_pending, rate_missing_no_estimate
