# shared_health_push_failed (P1)
**Severity:** P1 look today
## What it means
After the platform number's health changed in D1, the push of the new state to one member's workspace Durable Object failed (`pushToMembers` in src/core/numbers/health-events.ts). Fields: `workspace` (the member), `phoneNumberId`.
## Impact
That member keeps its old copy of the number's health, so its send gate may be wrong (too open or too closed) until it is repaired. Other members were still updated.
## Check first
1. Search logs for `{"alert":"shared_health_push_failed"`.
2. Compare D1 `shared_numbers.health_state` with that workspace's latest `number_health_log` row.
3. Read docs/number-health.md ("The platform (shared) number", Ruling WA-B-SHARED-1).
## Fix
1. The system repairs it itself: the state is set again when the store joins or rejoins, and by the daily shared-number sweep (`reconcileSharedHealth`), so the gap is at most about a day.
2. If it fails repeatedly for one workspace, check that its Durable Object is reachable. Not documented in code: ask the engineer on call.
## Verify it is resolved
The member's latest `number_health_log` row equals `shared_numbers.health_state`, and no new alert fires after the next daily sweep.
## Related
docs/number-health.md, docs/shared-number.md, alert: number_restricted
