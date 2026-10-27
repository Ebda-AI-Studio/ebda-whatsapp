# instapay_proof_overdue (P1)
**Severity:** P1 look today
## What it means
Fires once per request from `overdueOne` (src/core/billing/instapay.ts) when an InstaPay proof has been `under_review` for more than 4 business hours (Sunday to Thursday, 09:00-17:00 Africa/Cairo). Fields: `id`, `workspace`, `kind` (package or top-up), `amountMinor`, `waitedBusinessMinutes`.
## Impact
A merchant has paid by InstaPay and is waiting for an operator to review the proof. Nothing is wrong with the money; the service is late.
## Check first
1. Search logs for `{"alert":"instapay_proof_overdue"` and note `id`.
2. List the queue: `GET /api/v1/operator/instapay?state=under_review`.
3. Open the proof: `GET /api/v1/operator/instapay/:id/proof-link` (the link works for 2 minutes).
## Fix
1. Check the transfer in the bank/InstaPay app against `amountMinor`.
2. Confirm with `POST /api/v1/operator/instapay/:id/confirm` or reject with `POST /api/v1/operator/instapay/:id/reject` (a reason is required; the operator who created it cannot decide it; amounts at or above the adjustment threshold need two different approvers).
3. Confirmation grants immediately; if the grant fails see instapay_grant_failed. The alert fires once and does not repeat.
## Verify it is resolved
The request is no longer `under_review` (`confirmed` with `granted_at`, or `rejected`).
## Related
docs/billing.md (InstaPay review SLA); docs/launch/README.md; alerts: instapay_overdue_check_failed
