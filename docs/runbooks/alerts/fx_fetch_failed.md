# fx_fetch_failed (P1)
**Severity:** P1 look today
## What it means
Every FX source (fawazahmed0 on jsDelivr, its Pages mirror, open.er-api.com) failed or answered something that did not validate, or the daily step threw (field `error`).
## Impact
The last rate stays in use. Nothing is mis-priced, but the rate ages; after 48 h `fx_rate_stale` fires.
## Check first
Read the alert fields, then follow the steps under Fix.
## Fix
1. From a shell: `curl -s https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json | head -c 300` and `curl -s https://open.er-api.com/v6/latest/USD | head -c 300`. 2. If the format changed, fix the Zod schema in `src/core/billing/fx-daily.ts`. 3. If it is an outage, wait: the next daily run retries. To publish now, `POST /api/v1/operator/fx-rates` (>= 24 h ahead).
## Verify it is resolved
`fx_rates` gets a new row with `obs_day` = today (`GET /api/v1/operator/fx-rates`).
## Related
docs/billing.md#daily-fx-rate-wa-fx-daily-1, docs/plans/2026-11-12-daily-fx-rate.md
