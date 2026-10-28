# instapay_confirmed_not_granted (P0)
**Severity:** P0 wake someone now
## What it means
The daily `repairInstapay` (`src/core/billing/instapay.ts`) found an `instapay_requests` row with `state = 'confirmed'` and `granted_at IS NULL` (a crash between the confirm and the grant). It calls `grant` for it, then raises the alert once per request. Fields: `id`, `workspace`.
## Impact
A merchant's InstaPay payment was confirmed by an operator but the package or top-up credit may not have landed. Money was received.
## Check first
1. Search logs for `{"alert":"instapay_confirmed_not_granted"...}`; note `id`.
2. `GET /api/v1/operator/instapay?state=confirmed` and find the request.
3. Look for `instapay_repair_failed` or `instapay_grant_failed` for the same `id`.
4. Read docs/billing.md, "InstaPay billing", the "Effects, exactly once" item.
## Fix
1. The system repairs itself: the alert is raised right after the repair `grant` call succeeded, and the grant is idempotent (ref `instapay:<reference>`).
2. If `instapay_repair_failed` fired instead, the daily pass retries; escalate to the engineer on call if it repeats.
3. Do not confirm again by hand without the engineer: Not documented in code whether a second `POST /instapay/:id/confirm` is advisable here, ask the engineer on call.
## Verify it is resolved
The request has `granted_at` set and the package shows on the workspace (or the wallet shows the credit).
## Related
docs/billing.md; package_paid_not_granted
