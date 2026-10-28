# campaign_wallet_settle_failed (P1)
**Severity:** P1 look today
## What it means
Fires from src/core/campaigns/campaigns.ts when closing a campaign page's wallet reservation (`walletSettle`) fails, either right after the last page or in the campaign sweep. Fields: `workspace`, `error`.
## Impact
Money may be wrong for a while: the merchant's wallet may still show a hold for recipients that were not sent (an over-reserve), until the settlement goes through. Nothing is charged twice; settlement is idempotent per reservation reference.
## Check first
1. Search logs for `{"alert":"campaign_wallet_settle_failed"` and note `workspace`.
2. Read the wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
3. Read docs/campaigns.md (wallet hooks) and docs/billing.md.
## Fix
1. The system repairs it: the `campaign_step` sweep retries every unsettled page of completed or cancelled campaigns every 10 minutes while any is pending.
2. If it fires repeatedly, the wallet side is failing: check for `ledger_mirror_mismatch` and ask the engineer on call. Do not post wallet adjustments by hand for this.
## Verify it is resolved
The alert stops, and the wallet no longer shows the stale hold.
## Related
docs/campaigns.md; docs/billing.md; alerts: campaign_wallet_unavailable, ledger_mirror_mismatch
