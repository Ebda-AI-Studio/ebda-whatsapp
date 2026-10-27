# refund_debit_incomplete (P0)
**Severity:** P0 wake someone now
## What it means
`src/core/billing/refunds.ts` approves a refund in two phases: first it posts every wallet debit, then it calls the card provider. This alert fires when a wallet debit cannot be posted (the balance shrank after the plan) and the debit phase aborts. Fields: `requestId`, `workspace`. The call site passes `severity: 'P1'` and docs/billing.md calls it P1; this runbook treats it as P0 per policy.
## Impact
One refund request is stuck in `processing`. No provider call was made, so no card money left. Some wallet debits of the plan may already be posted. The merchant has not been paid.
## Check first
1. Search logs for `{"alert":"refund_debit_incomplete"...}`; note `requestId`.
2. `GET /api/v1/operator/refund-requests?state=processing` and find the request.
3. `GET /api/v1/operator/workspaces/:workspaceId/wallet` for the current balance.
4. Read docs/billing.md, section "Card refunds and the refund webhook", the "Debit phase first" item.
## Fix
1. Do not retry blindly and do not delete ledger rows.
2. The plan (`refund_chunks`) is fixed once recorded and a resumed approval replays it, so the run can be repeated only after the balance covers the remaining debits.
3. Whether to resume, or to abandon (`POST /api/v1/operator/refund-requests/:id/abandon`, which reverses posted `refund:<id>:*` debits): Not documented in code: ask the engineer on call to choose.
## Verify it is resolved
The request leaves `processing` (`debit_complete` set, then `paid` or `manual_payout`), or it is `abandoned` and the wallet debits are reversed. The wallet balance matches.
## Related
docs/billing.md; card_refund_over_refundable; docs/runbooks/alerts.md
