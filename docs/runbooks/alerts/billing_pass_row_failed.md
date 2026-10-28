# billing_pass_row_failed (P1)
**Severity:** P1 look today
## What it means
One row threw inside a daily money pass (`pass` names it, `error` is the error class). Fires from src/core/billing/drain.ts. The pass continued with the rows behind it, and the row is tried again on the next pass.
## Impact
One merchant's renewal, expiry or reconciliation did not happen today. Others were not affected.
## Check first
1. Search the Worker logs for `billing_pass_row_failed` and the matching error line near it.
2. Find the row of that pass in D1 (read only) and check what is odd about it (a missing plan, a bad amount).
## Fix
1. Repair the data the row depends on, or handle that merchant by hand from the operator console.
2. Anything beyond that: Not documented in code: ask the engineer on call.
## Verify it is resolved
The next daily pass handles that row without the alert.
## Related
docs/billing.md; alerts: billing_pass_backlog
