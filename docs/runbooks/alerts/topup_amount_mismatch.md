# topup_amount_mismatch (P0)
**Severity:** P0 wake someone now
## What it means
A confirmed SUCCESS payment for a top-up has a currency or amount different from the stored total (`applyTopupWebhook` in `src/core/billing/topups.ts`). Raised once per order (`auditOnce`). Field: `workspace`. The wallet is not credited.
## Impact
The merchant paid by card but the wallet was not topped up. Money was taken and not credited.
## Check first
1. Search logs for `{"alert":"topup_amount_mismatch"...}`; note `workspace`.
2. D1 (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT order_id, total_minor, currency, state FROM topups WHERE workspace_id = '<id>' ORDER BY created_at DESC LIMIT 5"` and compare with Kashier.
3. Read docs/billing.md, "Top-ups".
## Fix
1. The daily repair does not fix it (a wrong amount changes nothing).
2. Decide with the engineer: refund the card payment, or credit the wallet through the operator adjustments flow (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`, then `POST /api/v1/operator/adjustments/:id/decision`).
3. Why the amount differed: Not documented in code: ask the engineer on call.
## Verify it is resolved
`GET /api/v1/operator/workspaces/:workspaceId/wallet` shows the credit, or Kashier shows the refund; no new alert for the order.
## Related
docs/billing.md; package_amount_mismatch
