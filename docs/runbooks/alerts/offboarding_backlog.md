# offboarding_backlog (P1)
**Severity:** P1 look today
## What it means
The daily offboarding pass (`runDueOffboardings`, src/core/ops/offboarding.ts) stopped at its cap with due deletions left. Fields `processed`, `held`, `failed`. Usually many holds or failures at once, not volume.
## Impact
Several deletions are late. Each one has its own held or failed alert; this one says the queue is not draining.
## Check first
1. `GET /api/v1/operator/offboardings?state=pending`: how many are due, and their `lastError`.
2. Look for a common cause: the same hold reason on all of them, or the same failing step.
## Fix
1. Clear the common cause (see offboarding_held and offboarding_failed).
2. Re-run now: `POST /api/v1/operator/offboardings/run`. Steps are idempotent, running it twice is safe.
## Verify it is resolved
The pending list shrinks after the run and the next daily pass raises no backlog alert.
## Related
docs/offboarding.md (steps, holds, second approver); alerts: offboarding_failed, offboarding_held
