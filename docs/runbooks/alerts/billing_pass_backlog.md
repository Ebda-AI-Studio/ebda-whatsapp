# billing_pass_backlog (P1)
**Severity:** P1 look today
## What it means
A daily money pass stopped after its page cap with work left (`pass` names it, `handled` is how many rows it did). Fires from src/core/billing/drain.ts. The next daily pass continues.
## Impact
Renewals, expiries or reconciliations are late by a day or more. No row is lost; it is a throughput or upstream problem.
## Check first
1. Which `pass`? Search logs for `billing_pass_backlog` and read `handled`.
2. Look for what slows it: a provider outage (Kashier), D1 trouble, or a real spike in rows.
## Fix
1. Fix the upstream cause.
2. Do nothing else: the next daily pass continues where this stopped. If a row is urgent, handle it by hand from the operator console.
## Verify it is resolved
The next daily pass handles fewer rows than the cap and raises no backlog alert.
## Related
docs/billing.md; alerts: billing_pass_row_failed
