# wallet_debt_suspended (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/engine.ts (debtGuard) when a workspace wallet debt passes twice its overdraft limit after a charge at delivery, a Meta adjustment, a shared-number true-up or a chargeback. Fields: `workspace`, `debtMinor`, `limitMinor`. The entry that caused it was recorded in full; nothing was refused.
## Impact
The workspace is suspended with the reason `wallet_debt`: no sends leave (same switch as the operator suspension). Inbound and reading still work. Nothing is lost.
## Check first
1. Read the wallet ledger of the workspace (operator wallet view): the last `meta_charge`, `meta_adjust`, `chargeback` or `adjustment` rows show how the debt grew.
2. `GET /api/v1/operator/workspaces/:id/ops`: `suspendedReason` should read `wallet_debt`. Any other reason is an operator suspension and this alert did not set it.
## Fix
1. The merchant tops up. When the balance is back inside the overdraft limit the suspension lifts by itself (only while the reason is still `wallet_debt`).
2. If the debt is wrong (a bad adjustment), post a corrective ledger adjustment with an actor and a note; the same lift applies.
## Verify it is resolved
`suspendedReason` is empty, a test send is accepted, and no new alert fires.
## Related
docs/billing.md ("Debt guard"); wallet_low_balance; wallet_wait_expired
