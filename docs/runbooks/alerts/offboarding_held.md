# offboarding_held (P1)
**Severity:** P1 look today
## What it means
A due workspace deletion is waiting for a person. Fires once per hold from `runOffboarding` (src/core/ops/offboarding.ts) with `workspace` and `reason`: `open_refund`, `open_card_refund`, `open_yearly_refund_request`, `payment_in_flight`, `balance_grew`, `suspended_abuse` or `second_approval_required`. Nothing was erased; the pass retries daily.
## Impact
The deletion is late. The merchant (or the data-protection clock) is waiting, and money may still be open.
## Check first
1. `GET /api/v1/operator/workspaces/:workspaceId/offboarding`: read `stepsDone`, `lastError` (`held:<reason>`) and `needsSecondApproval`.
2. Money holds: look at the open refund request, card refund or InstaPay request of that workspace (`GET /api/v1/operator/refund-requests`, `GET /api/v1/operator/instapay`).
## Fix
1. `open_refund` / `open_card_refund` / `open_yearly_refund_request` / `payment_in_flight`: settle or reject the open money item; the next pass continues.
2. `balance_grew`: the owner cancels (`DELETE /api/v1/stores/:storeId/offboarding`) or an operator tells the merchant the new amount and re-sends `POST /api/v1/operator/workspaces/:workspaceId/offboarding` with `acceptWriteOff: true`.
3. `suspended_abuse`: export what the case needs, then `POST /api/v1/operator/workspaces/:workspaceId/offboarding/release-hold` with a reason.
4. `second_approval_required`: a different operator (not the requester, not anyone who touched the request) calls `POST /api/v1/operator/workspaces/:workspaceId/offboarding/approve` with a reason.
## Verify it is resolved
`lastError` no longer starts with `held:` and the next daily pass moves the state toward `done`.
## Related
docs/offboarding.md (steps, holds, second approver); alerts: offboarding_failed, offboarding_backlog
