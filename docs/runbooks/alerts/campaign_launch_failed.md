# campaign_launch_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `launchCampaign` (src/core/campaigns/campaigns.ts) when starting the campaign's Cloudflare Workflow instance (`CAMPAIGN_WORKFLOW.create`) throws. Fields: `workspace`, `attempt` (the generation number), `error`.
## Impact
A scheduled or running campaign has no workflow driving it, so no new pages are sent until it is restarted. No money is reserved or spent by the failure itself.
## Check first
1. Search logs for `{"alert":"campaign_launch_failed"` and note `workspace`, `attempt`.
2. Read the workspace's `campaigns` state through the merchant API `GET /api/v1/stores/:storeId/campaigns`.
3. Check Cloudflare dashboard, Workflows, for platform errors.
4. Read docs/campaigns.md (sweep).
## Fix
1. The system repairs it: the workspace's `campaign_step` sweep runs every 10 minutes while a campaign is scheduled or running and starts a new workflow generation.
2. After 30 generations it pauses the campaign with reason `internal_error` and raises campaign_paused_internal_error.
3. If it repeats for many workspaces, treat it as a Workflows incident: ask the engineer on call.
## Verify it is resolved
The campaign moves forward (`counts` grow) and the alert stops.
## Related
docs/campaigns.md; alerts: campaign_paused_internal_error, campaign_wallet_unavailable
