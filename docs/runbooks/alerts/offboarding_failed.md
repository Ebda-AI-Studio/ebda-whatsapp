# offboarding_failed (P1)
**Severity:** P1 look today
## What it means
A workspace deletion stopped. Fires from `runOffboarding` (src/core/ops/offboarding.ts) when a step throws (fields `workspace`, `step`, `error` = the error class, never its text; `error: no_key` = the pseudonym key is missing) and from the daily pass in src/index.ts when the whole pass throws. The step is retried on the next pass; steps are idempotent.
## Impact
A merchant who asked to leave (or an operator who removed them) still has data in the system, and a data-protection deadline may be running. Nothing is half-deleted from the merchant's view: the workspace stays suspended until the last step.
## Check first
1. `GET /api/v1/operator/workspaces/:workspaceId/offboarding` shows `stepsDone`, `lastError` and `attempts`.
2. `step: r2` with `unfinished` means more than 20,000 objects; it continues by itself.
3. `no_key`: the pseudonym secret is not set on the Worker (see docs/runbooks/token-enc-key-rotation.md for how secrets are checked); set it, then re-run.
4. A D1 or Durable Object error class: search the Worker logs for the workspace id around the alert time.
## Fix
1. Fix the cause (a missing secret, a D1 incident).
2. Re-run now: `POST /api/v1/operator/offboardings/run`. It resumes at the failed step.
3. Still failing after two passes: Not documented in code: ask the engineer on call.
## Verify it is resolved
`GET /api/v1/operator/workspaces/:workspaceId/offboarding` shows the state `done` (or the row is gone with the workspace) and the alert stops on the next daily pass.
## Related
docs/offboarding.md (steps, holds, second approver); alerts: offboarding_held, offboarding_backlog
