# offboarding_debt_outstanding (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/ops/offboarding.ts (the `suspend` step) when a workspace being deleted still has a negative wallet. Fields: `workspace`, `debtMinor`. The data erasure is NOT blocked; the debt is recorded once in the append-only offboarding log (`debt_preserved`, amount) and stays in the kept ledger copy (`ledger_mirror`).
## Impact
The merchant owes the platform this amount. Nothing is written off and nothing is paid or refunded against it on the way out.
## Check first
1. `GET /api/v1/operator/workspaces/:id/offboarding` and the offboarding log row `debt_preserved`.
2. The kept ledger rows for the workspace in `ledger_mirror` (last `balance_after`).
## Fix
1. Decide with the business whether to pursue the debt. Writing it off is a person's explicit decision on the existing approval path, never automatic.
2. Hold any refund or payout for this merchant until the decision is made.
## Verify it is resolved
The decision is recorded in the offboarding log and no payout or refund went out against the debt.
## Related
docs/offboarding.md; docs/billing.md ("Debt guard"); wallet_debt_suspended
