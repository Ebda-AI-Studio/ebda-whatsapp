# NEW-CAP-ATOMIC-1

Ruling NEW-CAP-ATOMIC-1 - the new-workspace campaign cap is reserved in ONE conditional D1 statement (`reserveNewCap`: insert only if the workspace has an owner row AND owner-sum + n <= cap AND number-sum + n <= cap), and a page is queued only if that reservation succeeded. A missing `workspace_owners` row refuses the send (`owner_unknown`, step retries), it no longer counts as zero usage.

Second form (PR #38 security review, cross-tenant DoS): the number scope applies ONLY to a tenant's own number (`phone_numbers.kind = 'own'`, checked inside the same statement). The shared platform number pools strangers, so a number scope there let one tenant exhaust the allowance for every other new tenant for 24 h; on it the scopes are per owner and per workspace. Tests: `test/new-cap-atomic.test.ts` (platform: A exhausted, B on the same number still sends; own number: number scope still caps across owners). Cost if wrong: strangers on the platform number are no longer capped as a group (platform-level protection is the shared-number template-only rule WA-SHARED-NOCAMP-1 and number health), and a number mis-flagged `own` stays pooled.

Evidence: the old `newCapUsage` (read) then `reserveNewCap` (insert, run after the wallet reserve) were two steps, so two workspaces of one owner or on one number could both read room and both insert; owner `''` matched no rows, so a missing owner row was fail-open. Tests: `test/new-cap-atomic.test.ts` (concurrent pair -> exactly one wins, missing owner refused, same ref idempotent) and `test/review-minors-2.test.ts`.

Cost if wrong: a legitimate new workspace whose Store `store.linked` event is delayed sends no campaigns until the owner row lands (retries every step); an over-strict cap could delay a page by one 30 s wait.
