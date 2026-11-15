# credit_pack_refunded (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/credit-packs.ts (applyCreditWebhook) when the card provider confirms a refund or chargeback of a payment for AI credits. Field: `workspace`, `orderId`. Credits are never taken back automatically because some may already be spent.
## Impact
The merchant got money back and may still hold the credits. Nothing in the ledger changed.
## Check first
1. Search logs for `{"alert":"credit_pack_refunded"` and note the fields.
2. Read D1 `credit_orders` for the order (state, `transaction_id`) and the workspace's `credit_ledger` rows with ref `credit-pack:<transactionId>`.
3. Read docs/billing.md, section "AI credit packs".
## Fix
1. Read the `credit_ledger` purchase row (ref `credit-pack:<transactionId>`) and the balance since.
2. Decide with the business whether to remove the unspent part. There is no operator screen for credit adjustments today: the engineer on call posts an `adjustment` row through `postAiCredits` (an actor and a note are required). The system never removes credits by itself.
## Verify it is resolved
The decision is recorded (a credit-ledger adjustment, or a note that the credits stay) and no further alert follows.
## Related
docs/billing.md ("AI credit packs"); alerts: credit_pack_amount_mismatch; topup_refunded_by_provider
