# instapay_grant_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `confirmInstapay` (src/core/billing/instapay.ts) when an operator confirmed an InstaPay request (state `confirmed`) but granting the package or top-up threw. Fields: `id` (request id), `workspace`, `error`.
## Impact
Money was received and the request is confirmed, but the merchant has not got the package or wallet credit yet.
## Check first
1. Search logs for `{"alert":"instapay_grant_failed"` and note `id`, `workspace`.
2. Read the `instapay_requests` row: `state = 'confirmed'`, `granted_at` empty.
3. Compare `amount_minor` with the matching `package_orders` or `topups` row for the same id.
4. Read docs/billing.md (InstaPay effects).
## Fix
1. The system repairs it: `repairInstapay` retries every confirmed request with no `granted_at` on the daily pass (cron `17 1 * * *`), and the grant is idempotent. Expect `instapay_confirmed_not_granted` when that repair succeeds.
2. If `instapay_repair_failed` follows for the same id, the cause is in the data: Not documented in code: ask the engineer on call.
3. Do not confirm the request again; it is already confirmed.
## Verify it is resolved
`instapay_requests.granted_at` is set and the package or wallet credit is visible (`GET /api/v1/operator/workspaces/:workspaceId/wallet`).
## Related
docs/billing.md (InstaPay); alerts: instapay_confirmed_not_granted, instapay_repair_failed
