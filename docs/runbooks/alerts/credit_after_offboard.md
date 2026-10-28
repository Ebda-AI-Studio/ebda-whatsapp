# credit_after_offboard (P1)
**Severity:** P1 look today
## What it means
A payment confirmation, grant, adjustment or provider refund reached a workspace that is deleted (its id starts with `del_`) or is being wiped. Fires from `src/core/ops/offboarded.ts` with `workspace`, `what` and `ref`. Nothing was credited and no workspace was created for it; the row is in `billing_audit` as `credit_after_offboard`.
## Impact
If a customer paid, the money is in the provider or bank account and the customer has nothing for it. Money owed back, not an outage.
## Check first
1. Find the row: `SELECT at, ref FROM billing_audit WHERE action = 'credit_after_offboard' ORDER BY id DESC LIMIT 5` (D1 `ebda-wa-platform`, read only).
2. `ref` names what it was and the order id; match it in the provider dashboard (Kashier) or the bank app.
## Fix
1. Refund the payer by hand from the provider dashboard or the bank.
2. Note the order id and the refund reference in the incident log. The order row stays unpaid on purpose.
3. If it repeats for one provider, a webhook is still pointed at a deleted store: tell the engineer on call.
## Verify it is resolved
The provider shows the refund, and no further `credit_after_offboard` rows appear for that order.
## Related
docs/offboarding.md (OFFBOARD-LATE-CREDIT-1); docs/billing.md
