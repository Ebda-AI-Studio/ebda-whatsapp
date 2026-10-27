# refund_abandon_sweep_failed (P1)
**Severity:** P1 look today
## What it means
Fires from `sweepAbandonedRefunds` (src/core/billing/card-refunds.ts) when the daily backstop that reverses wallet debits of an abandoned refund request throws for one request, or from `dailyBilling` when the step throws. Fields: `requestId`, `error`.
## Impact
Money may be wrong: an abandoned refund request may still have wallet debits (`refund:<id>:<n>`) that have not been credited back, so a merchant's wallet could be short.
## Check first
1. Search logs for `{"alert":"refund_abandon_sweep_failed"` and note `requestId`.
2. Read the `refund_requests` row: `state = 'abandoned'`, `swept_at` empty means not yet clean.
3. Look at the workspace wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet` for `refund-reversal:<id>:<n>` entries.
4. Check whether `refund_reversal_blocked` fired: it means a card refund row may have sent money, so nothing is reversed.
## Fix
1. The sweep runs on every daily pass (cron `17 1 * * *`) and handles 200 requests per pass; a reversal uses an idempotent ref, so repeating it is safe.
2. If it keeps failing for the same `requestId`: Not documented in code: ask the engineer on call. Do not post wallet adjustments by hand for this request.
## Verify it is resolved
`refund_requests.swept_at` is set for the request, a `refund-reversal:<id>:<n>` entry exists for each posted chunk, and the alert stops.
## Related
docs/billing.md (abandoning a partly debited request); alerts: refund_debit_incomplete, refund_reversal_blocked
