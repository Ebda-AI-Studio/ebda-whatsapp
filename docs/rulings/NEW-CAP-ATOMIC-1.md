# NEW-CAP-ATOMIC-1

Ruling NEW-CAP-ATOMIC-1 - the new-workspace campaign cap is reserved in ONE conditional D1 statement (`reserveNewCap`: insert only if the workspace has an owner row AND owner-sum + n <= cap AND number-sum + n <= cap), and a page is queued only if that reservation succeeded. A missing `workspace_owners` row refuses the send (`owner_unknown`, step retries), it no longer counts as zero usage.

Evidence: the old `newCapUsage` (read) then `reserveNewCap` (insert, run after the wallet reserve) were two steps, so two workspaces of one owner or on one number could both read room and both insert; owner `''` matched no rows, so a missing owner row was fail-open. Tests: `test/new-cap-atomic.test.ts` (concurrent pair -> exactly one wins, missing owner refused, same ref idempotent) and `test/review-minors-2.test.ts`.

Cost if wrong: a legitimate new workspace whose Store `store.linked` event is delayed sends no campaigns until the owner row lands (retries every step); an over-strict cap could delay a page by one 30 s wait.
