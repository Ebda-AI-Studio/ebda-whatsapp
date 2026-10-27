# rate_unavailable (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/engine.ts (estimateMinor) when a send on a platform-funded number needs a price and the rate card has none for the recipient market and category. Fields: `workspace`, `country`, `category`. The send is refused rather than priced at 0.
## Impact
The send is refused with `rate_unavailable` (API 409); a campaign pauses with that reason. Nothing is sent or charged. No money is wrong.
## Check first
1. Search logs for `{"alert":"rate_unavailable"...}` and note `country` and `category`.
2. List the published rate cards and FX rates: `GET /api/v1/operator/rate-cards` and `GET /api/v1/operator/fx-rates` (super admin).
3. Read docs/billing.md, section "Money flow for a platform_line message", step 2 (Pre-send).
## Fix
1. Publish the missing rate: `POST /api/v1/operator/rate-cards` (new versions must be dated at least 24 h ahead per docs/billing.md, so the refusal can last until then). Publish FX with `POST /api/v1/operator/fx-rates` if it is missing.
2. The system does not fill the gap by itself. The merchant resends refused messages and resumes paused campaigns.
## Verify it is resolved
The rate card list shows a version covering that country and category, a new send is accepted, and the alert stops.
## Related
docs/billing.md#money-flow-for-a-platform_line-message; funding_unknown; rate_missing_no_estimate
