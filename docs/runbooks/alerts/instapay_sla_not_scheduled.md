# instapay_sla_not_scheduled (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/instapay.ts when an InstaPay proof was saved but the one-shot review-deadline check (workspace Durable Object task `instapay_overdue`, due 4 business hours later) could not be scheduled. Fields: `id` (the InstaPay request), `error` (an error class name).
## Impact
The request is `under_review` as normal, but the on-time `instapay_proof_overdue` alert may not fire at the 4 business-hour deadline. The merchant's payment is not lost and no money is wrong.
## Check first
1. Search logs for `{"alert":"instapay_sla_not_scheduled"...}` and note `id`.
2. List waiting requests: `GET /api/v1/operator/instapay?state=under_review` (super admin).
3. Read docs/billing.md, section "InstaPay billing", the Daily and Review SLA bullets.
## Fix
1. The system backs itself up: the daily `overdueInstapay` pass still raises the overdue alert (up to a day late).
2. Review the request now: confirm or reject with `POST /api/v1/operator/instapay/:id/confirm` or `.../reject` (super admin).
## Verify it is resolved
The request leaves `under_review` (confirmed or rejected) and no overdue alert is pending.
## Related
docs/billing.md#instapay-billing-instapay_billing_enableddefault-off; instapay_confirmed_not_granted
