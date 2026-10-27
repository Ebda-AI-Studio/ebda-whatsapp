# topup_repair_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `repairTopups` (src/core/billing/topups.ts) when crediting one pending Kashier top-up fails during the daily pass, or from `dailyBilling` (src/index.ts) when the whole step throws. Field: `error` (the error class name).
## Impact
A merchant who paid by card may not have their wallet credited yet. Money may be owed to the merchant, but nothing is double-charged: the credit path is idempotent.
## Check first
1. Search logs for `{"alert":"topup_repair_failed"`; note the `error` class.
2. Read the `topups` table in D1 for rows with `provider = 'kashier'` and `state = 'pending'` (repair only looks at these).
3. Read the workspace wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
4. Read docs/billing.md (top-ups and repair).
## Fix
1. The daily pass (cron `17 1 * * *`) asks Kashier again for every still-pending top-up, so a transient failure heals itself the next day. Pending top-ups older than the expiry window are marked `expired`.
2. If the same `error` repeats for several days, ask the engineer on call: Not documented in code: ask the engineer on call.
3. Do not edit ledger rows by hand. Wallet corrections go through the operator adjustment routes (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`).
## Verify it is resolved
The alert does not fire on the next daily pass, the `topups` row is `credited`/`expired` instead of `pending`, and the wallet shows the credit.
## Related
docs/billing.md; alerts: topup_amount_mismatch, webhook_reconfirm_failed; docs/runbooks/alerts.md
