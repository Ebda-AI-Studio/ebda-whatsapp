# number_restricted (P0)
**Severity:** P0 wake someone now
## What it means
A phone number's health state worsened to `red` or `restricted` (Meta restriction, ban or a red rating). Fires in `src/core/workspace-do.ts` (a merchant number) and in `src/core/numbers/health-events.ts` (the shared platform number, with `shared: true`). Fields: `workspace`, `phoneNumberId`, `from`, `to`, `source`, `pausedCampaigns`.
## Impact
Campaigns on the number are paused (`pause_reason = quality_flagged`) and new template sends are refused with `error_reason = number_restricted`; holds are released. Replies inside the 24 h window still go. For the shared number, every member store is affected. No money is lost.
## Check first
1. Search logs for `{"alert":"number_restricted"...}`; note `phoneNumberId`, `to`, `source`.
2. `GET /api/v1/operator/workspaces/:workspaceId/ops` for the workspace status.
3. Read `phone_numbers.health_*` (D1, or `shared_numbers.health_*`) and the workspace `number_health_log`.
4. Read docs/number-health.md.
## Fix
1. Recovery is driven by Meta: a REINSTATE moves `restricted` to `yellow`, never straight to green.
2. Contact the merchant and resolve the restriction with Meta in the Meta Business Manager.
3. Recovery never resumes campaigns: the merchant resumes them.
4. For one abusive store on the shared number, the operator can use `POST /api/v1/operator/workspaces/:workspaceId/shared-number/evict` (see docs/number-health.md).
## Verify it is resolved
The latest `number_health_log` row (or `health_state`) is no longer `red` or `restricted`, and template sends are accepted again.
## Related
docs/number-health.md; docs/shared-number.md; docs/runbooks/alerts.md
