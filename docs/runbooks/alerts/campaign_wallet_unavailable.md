# campaign_wallet_unavailable (P1)
**Severity:** P1 look today
## What it means
Fires from the campaign page step (src/core/campaigns/campaigns.ts) when the wallet cannot be asked to estimate or reserve funds for a page. The page answers `retry` with reason `wallet_unavailable`. Fields: `workspace`, `error`.
## Impact
That merchant's campaign does not send the next page until the wallet answers. No money is reserved or charged for the failed attempt; no messages go out.
## Check first
1. Search logs for `{"alert":"campaign_wallet_unavailable"` and note `workspace`.
2. Read the wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
3. Check Cloudflare status and the workspace Durable Object for errors.
4. Read docs/campaigns.md (wallet hooks).
## Fix
1. The system repairs it: the step throws and Cloudflare Workflows retries with backoff, so a short outage heals itself.
2. If it repeats for a long time, check whether pricing or rates are missing (alerts such as `pricing_pull_failed`) and ask the engineer on call.
## Verify it is resolved
The campaign sends its next page (`counts` grow) and the alert stops.
## Related
docs/campaigns.md; docs/billing.md; alerts: campaign_wallet_settle_failed, campaign_launch_failed
