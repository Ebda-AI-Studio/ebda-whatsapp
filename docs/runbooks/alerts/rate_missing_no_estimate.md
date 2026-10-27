# rate_missing_no_estimate (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/engine.ts (chargeEstimate) when a delivered message waited 7 days for a rate (`pending_rate`) and no held estimate exists to charge instead. Field names: `workspace`, `country`.
## Impact
That message is not charged at all: Meta billed the platform and the merchant paid nothing for it. The merchant balance is not wrong, but we are under-collecting.
## Check first
1. Search logs for `{"alert":"rate_missing_no_estimate"...}` and note `workspace` and `country`.
2. Read the workspace Durable Object table `billable_sends` (rows with `pending_rate = 1` and `charged_ref` empty) and `wallet_holds`.
3. Read docs/billing.md, section "Money flow for a platform_line message", step 4 ("No rate found at delivery").
## Fix
1. Publish the missing rate for that country: `POST /api/v1/operator/rate-cards` (and `POST /api/v1/operator/fx-rates` if FX is missing). Rows still marked `pending_rate` are priced when a rate arrives.
2. For a row that is already past 7 days with no hold, how to charge it: Not documented in code: ask the engineer on call. The documented route for a manual wallet correction is `POST /api/v1/operator/workspaces/:workspaceId/adjustments`.
## Verify it is resolved
`billable_sends` for the affected rows has a `charged_ref`, or an approved adjustment appears in `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
## Related
docs/billing.md#money-flow-for-a-platform_line-message; rate_unavailable; rate_missing_estimate_charged
