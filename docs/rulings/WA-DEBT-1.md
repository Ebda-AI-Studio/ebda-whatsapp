# Ruling WA-DEBT-1

**Decision:** Wallet debt past 2 x the overdraft limit suspends sends for the workspace (reason `wallet_debt`) and alerts `wallet_debt_suspended` (P1). The ledger entry that caused the debt (delivery charge, Meta adjustment, chargeback) is always recorded in full and never refused. The suspension reuses the operator kill switch's two copies (DO flag `ops.suspended`, D1 `workspaces.suspended_at`) and lifts when the balance is back to `>= -limit`, only while the reason is still `wallet_debt`; an operator suspension is never overwritten or lifted by it.

**Evidence:** `src/core/billing/engine.ts` (`debtGuard`, `syncDebtSuspension`), `test/billing-wallet-debt.test.ts` (old code: the workspace stays unsuspended at balance -250 with a -100 limit). Precedent for a tagged reuse of `suspended_at`: `offboarding`.

**Cost if wrong:** a merchant with a large legitimate chargeback is blocked from sending until they top up (they are told through the existing wallet debt banner), and a limit of zero set by an operator makes any debt suspend.
