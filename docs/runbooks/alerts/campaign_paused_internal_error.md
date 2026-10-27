# campaign_paused_internal_error (P1)
**Severity:** P1 look today
## What it means
Fires from `sweepCampaigns` (src/core/campaigns/campaigns.ts) when a campaign's workflow keeps dying and reaches the maximum number of generations (30); the campaign is set to `paused` with `pause_reason = 'internal_error'`. Fields: `workspace`, `campaign`.
## Impact
That merchant's campaign stopped and will not restart by itself. Messages already queued are unaffected; unsent recipients wait. Spend already reserved is settled by the sweep.
## Check first
1. Search logs for `{"alert":"campaign_paused_internal_error"` and note `workspace`, `campaign`.
2. Look for earlier `campaign_launch_failed` alerts for the same workspace.
3. Read the campaign: `GET /api/v1/stores/:storeId/campaigns/:campaignId` (status and pause reason).
4. Read docs/campaigns.md (sweep and pause reasons).
## Fix
1. Find and fix the cause of the workflow dying (see the earlier alerts and Workflows logs).
2. Then the merchant resumes the campaign from the app; resume starts a new generation. The system never resumes it by itself.
3. If the cause is not clear: Not documented in code: ask the engineer on call.
## Verify it is resolved
After resume the campaign is `running`, `counts` grow, and no new alert appears.
## Related
docs/campaigns.md; alerts: campaign_launch_failed, campaign_wallet_settle_failed
