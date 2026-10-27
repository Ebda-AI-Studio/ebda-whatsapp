# shared_sweep_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `dailyBilling` (src/index.ts) when `sweepShared` (src/core/shared/shared-number.ts) throws. That daily housekeeping deletes parked shared-number messages older than 48 h and markers older than 24 h from R2, repairs missed member health pushes (`reconcileSharedHealth`), and deletes `shared_sent` rows older than 35 days. Field: `error`.
## Impact
Housekeeping is late: old R2 objects stay, and a shared-number health change that never reached a member may not be repaired yet. No money or consent impact.
## Check first
1. Search logs for `{"alert":"shared_sweep_failed"` and note `error`.
2. Check R2 (the `MEDIA` bucket) and D1 are reachable in the Cloudflare dashboard.
3. Read docs/shared-number.md (daily sweep) and docs/number-health.md.
## Fix
1. The sweep runs on every daily pass (cron `17 1 * * *`) and is safe to repeat, so a transient failure heals itself.
2. If it persists for several days: Not documented in code: ask the engineer on call.
## Verify it is resolved
The alert does not fire on the next daily pass.
## Related
docs/shared-number.md; docs/number-health.md; alerts: shared_sent_not_recorded, shared_template_refresh_failed
