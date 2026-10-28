# instapay_overdue_check_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `dailyBilling` (src/index.ts) when `overdueInstapay` (src/core/billing/instapay.ts) throws. That daily backstop finds InstaPay proofs under review for longer than 4 business hours that have not yet raised `instapay_proof_overdue`. Field: `error`.
## Impact
An InstaPay proof waiting for review may not be flagged as overdue. A merchant's payment may be waiting without anyone being told.
## Check first
1. Search logs for `{"alert":"instapay_overdue_check_failed"`.
2. List the queue: `GET /api/v1/operator/instapay?state=under_review` and look at the oldest `proof_at`.
3. Read docs/billing.md (review SLA: 4 business hours, Sunday to Thursday, 09:00-17:00 Africa/Cairo).
## Fix
1. Review the waiting proofs now: `GET /api/v1/operator/instapay/:id/proof-link`, then `POST /api/v1/operator/instapay/:id/confirm` or `/reject` (a different operator than the creator; large amounts need two approvers).
2. The scheduled per-request check (task `instapay_overdue`) and the next daily pass both retry the overdue alert; this alert is not a payment failure.
3. If it persists: Not documented in code: ask the engineer on call.
## Verify it is resolved
No `under_review` proof is older than the SLA and the alert stops on the next daily pass.
## Related
docs/billing.md (InstaPay); alerts: instapay_proof_overdue, instapay_expiry_failed
