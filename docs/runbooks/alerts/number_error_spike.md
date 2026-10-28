# number_error_spike (P1)
**Severity:** P1 look today
## What it means
25 Meta errors 131049 (frequency cap) or 131026 (undeliverable) hit one number inside 60 minutes (src/core/workspace-do.ts, src/core/numbers/health-events.ts). Fields: `workspace`, `phoneNumberId`, `from`, `to`, `source`, `pausedCampaigns`; on the platform number `shared: true`, and `ambiguous: true` when two members share the blame with no culprit.
## Impact
Campaigns on that number are paused, and green moves to yellow. On the platform number it may affect every member. No money is wrong.
## Check first
1. Search logs for `{"alert":"number_error_spike"`.
2. Read D1 `phone_numbers.health_*` or `shared_numbers.health_*`, D1 `shared_number_errors` and `shared_number_sends` for the platform number, and the workspace's `number_health_log`.
3. Read docs/number-health.md ("Spike guard", Rulings WA-B-SPIKE-1).
## Fix
1. Find which campaign or template is hitting the errors and tell the merchant.
2. For a bad member on the platform number use POST /api/v1/operator/workspaces/:workspaceId/shared-number/evict (reason 5-300 chars).
3. Recovery never resumes campaigns: the merchant does.
## Verify it is resolved
No new spike lines, number state returns to green, and errors stop in the log.
## Related
docs/number-health.md, docs/shared-number.md, alerts: number_member_abuse, number_quality_flagged, number_restricted
