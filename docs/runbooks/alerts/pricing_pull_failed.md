# pricing_pull_failed (P1)
**Severity:** P1 look today
## What it means
A workspace Durable Object (`src/core/workspace-do.ts`, pull of price inputs) could not copy the pricing tables from D1 (`rate_cards`, `fx_rates`, `pricing_settings`, `workspace_pricing_overrides`, `number_funding`; see `pullPricing` in `src/core/billing/pricing.ts`). Fields: `workspace`, `error` (error class).
## Impact
The workspace keeps pricing from its last good copy. It retries after about 1 minute (the copy is otherwise refreshed every 30 minutes). If the copy was never filled, sends are deferred, see pricing_copy_missing. Money is not mis-posted: no wallet decision runs on an empty copy.
## Check first
1. Search the logs for `{"alert":"pricing_pull_failed"...}`; note `workspace` and `error`.
2. Is it one workspace or all? All workspaces points at D1 (check Cloudflare D1 status and the D1 binding).
3. Confirm the pricing tables have current rows: `GET /api/v1/operator/rate-cards`, `/fx-rates`, `/pricing-settings`.
## Fix
1. Fix the cause (D1 outage or error shown in `error`).
2. The system repairs itself: the workspace pulls again within a minute and on the next billing activity. No manual step is needed once D1 answers.
## Verify it is resolved
No new `pricing_pull_failed` line for the workspace, and pricing_copy_missing stops for it.
## Related
pricing_copy_missing, docs/billing.md#who-pays-meta-wa-fund-1, docs/billing.md#alerts-structured-logs
