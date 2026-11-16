# credit_pack_refunded (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/credit-packs.ts (applyCreditWebhook) when the card provider confirms a refund or chargeback of a payment for AI credits. Fields: `workspace`, `orderId`, `packCredits`, `expiredCredits`, `spentCredits`, and `notCredited: true` when the refund arrived before the pack was credited (nothing was spent; the refund is recorded and the later credit expires itself). The unused part of the pack was already expired automatically (WA-PACK-REFUND-1); only the part that was already spent (`spentCredits`) is left for a person.
## Impact
The merchant got money back. The unused credits are gone; the credits they already used stay used, so the business carries that cost unless it decides otherwise.
## Check first
1. Search logs for `{"alert":"credit_pack_refunded"` and note the fields.
2. Read D1 `credit_orders` for the order (state, `transaction_id`) and the workspace's `credit_ledger` rows with ref `credit-pack:<transactionId>`.
3. Read docs/billing.md, section "AI credit packs".
## Fix
1. Read the `credit_ledger` purchase row (ref `credit-pack:<transactionId>`) and the balance since.
2. Nothing to remove: the unused part expired (an `expire` row, ref `credit-pack-refund:...`). If `spentCredits` is large, decide with the business whether to recover it (a credit-ledger adjustment through `postAiCredits` needs an actor and a note) or write it off.
## Verify it is resolved
The decision is recorded (a credit-ledger adjustment, or a note that the credits stay) and no further alert follows.
## Related
docs/billing.md ("AI credit packs"); alerts: credit_pack_amount_mismatch; topup_refunded_by_provider
