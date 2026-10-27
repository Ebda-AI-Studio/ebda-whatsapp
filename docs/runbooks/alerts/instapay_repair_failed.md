# instapay_repair_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `repairInstapay` (src/core/billing/instapay.ts) when the daily repair of a confirmed InstaPay request whose grant never finished throws. Fields: `id` (the request id), `error` (error class name). It fires once per request, not every day. A whole-step failure in `dailyBilling` uses the same name without `id`.
## Impact
A merchant's InstaPay payment was confirmed by an operator but the package or top-up is not granted. Money was received; the merchant has not received the service.
## Check first
1. Search logs for `{"alert":"instapay_repair_failed"` and note `id`.
2. Read the `instapay_requests` row for that id: `state = 'confirmed'` with `granted_at` empty.
3. Compare its `amount_minor` with the matching `package_orders` or `topups` row for the same order id (a mismatch makes the grant throw).
4. List requests: `GET /api/v1/operator/instapay`.
## Fix
1. The grant is idempotent and the daily pass tries again, but the alert itself will not repeat for this request.
2. If the order and request disagree on amount or the top-up is bound to another transaction, the cause is in the data: Not documented in code: ask the engineer on call.
3. Do not edit ledger rows by hand; use the operator routes in docs/billing.md.
## Verify it is resolved
`instapay_requests.granted_at` is set and the package or wallet credit is visible (`GET /api/v1/operator/workspaces/:workspaceId/wallet`).
## Related
docs/billing.md (InstaPay); alerts: instapay_grant_failed, instapay_confirmed_not_granted
