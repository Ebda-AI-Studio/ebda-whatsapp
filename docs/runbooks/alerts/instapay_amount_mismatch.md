# instapay_amount_mismatch (P1)
**Severity:** P1 look today
## What it means
Fires from `confirmInstapay` (src/core/billing/instapay.ts) when an operator tries to confirm a request but the request's `amount_minor` differs from the amount on its order (`package_orders` or `topups`). Fields: `id`, `workspace`. The confirm is refused with `amount_mismatch` and nothing is granted.
## Impact
No money moved and nothing was granted. A merchant's payment cannot be confirmed until the data is explained; a tampered or corrupted row fails closed.
## Check first
1. Search logs for `{"alert":"instapay_amount_mismatch"` and note `id`.
2. Read `instapay_requests.amount_minor` and the order's `amount_minor` (same id in `package_orders.order_id` or `topups.order_id`).
3. Open the proof (`GET /api/v1/operator/instapay/:id/proof-link`) and see what the merchant actually paid.
## Fix
1. Do not push the grant through. Find out why the two amounts differ.
2. If the merchant paid the wrong amount, reject with a clear reason (`POST /api/v1/operator/instapay/:id/reject`) so they can submit a new request.
3. If the data looks tampered with or you cannot explain it: Not documented in code: ask the engineer on call.
## Verify it is resolved
The request is `rejected`, or the amounts agree and a later confirm succeeds; no new alert for that id.
## Related
docs/billing.md (InstaPay); alerts: package_amount_mismatch, topup_amount_mismatch, instapay_grant_failed
