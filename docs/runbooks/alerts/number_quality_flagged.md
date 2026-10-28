# number_quality_flagged (P1)
**Severity:** P1 look today
## What it means
A WhatsApp number moved to yellow after Meta's quality signal or a rating read (src/core/numbers/health-events.ts, src/core/workspace-do.ts). Fields: `workspace` (absent for the platform number), `phoneNumberId`, `from`, `to`, `source`, `pausedCampaigns`, and `shared: true` for the platform number.
## Impact
Running and scheduled campaigns on that number are paused (`quality_flagged`) and queued sends are parked. Service replies still go. For the platform number every member is affected. No money is wrong.
## Check first
1. Search logs for `{"alert":"number_quality_flagged"`.
2. Read D1 `phone_numbers.health_*` (or `shared_numbers.health_*`) and the workspace's `number_health_log`.
3. Read docs/number-health.md ("State machine").
4. GET /api/v1/operator/workspaces/:workspaceId/ops shows the workspace's operator state.
## Fix
1. Contact the merchant; they should fix content or opt-in quality in Meta.
2. Recovery never resumes campaigns: the merchant resumes them. Nothing resumes them automatically.
3. Do not hand-edit health rows.
## Verify it is resolved
The latest `number_health_log` row (or `health_state`) is green and the merchant has resumed their campaigns.
## Related
docs/number-health.md, docs/runbooks/alerts.md, alerts: number_restricted, number_error_spike
