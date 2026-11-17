# credit_pack_amount_mismatch (P0)
**Severity:** P0 wake someone
## What it means
Fires in src/core/billing/credit-packs.ts (applyCreditWebhook) when a confirmed payment for an AI credit order carries an amount or currency that is not the one stored on the order. Field: `workspace`. Nothing is credited.
## Impact
A merchant may have paid a different amount than the pack price. No credits were added, so the merchant has paid and received nothing until a person decides.
## Check first
1. Search logs for `{"alert":"credit_pack_amount_mismatch"` and note the fields.
2. Read D1 `credit_orders` for the order (state, `transaction_id`) and the workspace's `credit_ledger` rows with ref `credit-pack:<transactionId>`.
3. Read docs/billing.md, section "AI credit packs".
## Fix
1. Compare the signed amount from Kashier's record with `credit_orders.amount_minor`.
2. If the payment is real and the amount is right in substance, a person decides: refund it in the Kashier dashboard, or have the engineer on call add the credits with a `purchase` or `adjustment` row through `postAiCredits` (there is no operator screen for it). Never edit the order row.
## Verify it is resolved
`credit_orders.state` is `paid` with credits in the ledger once, or the payment is refunded and the order stays `pending` or `expired`.
## Related
docs/billing.md ("AI credit packs"); alerts: credit_pack_refunded; topup_amount_mismatch; package_amount_mismatch
