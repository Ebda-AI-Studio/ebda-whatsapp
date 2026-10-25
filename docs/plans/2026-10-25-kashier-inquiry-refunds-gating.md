# Kashier inquiry, card refunds, shared-number package gating (Track A)

Goal: three money-adjacent items, in order, each its own commit set, each reviewed before the next starts.

## Item a: Kashier inquiry (repair of stuck top-ups and package orders)
- `KashierProvider.inquire(orderId)`: look the payment up by OUR order id with the documented list call
  `GET {api}/v2/aggregator/transactions?search=<orderId>&type=payment` (`search` = "keyword for trxId or merchant orderId"), keep only records whose
  `merchantOrderId` equals the order id exactly, then confirm every candidate with the SAME transaction-details call the webhook path uses
  (`classifyKashierTransaction`: fixed https host, allow-listed ids, 8 s timeout, `KASHIER_SECRET_KEY`). Status comes only from the details answer.
- `repairTopups` applies a confirmed answer through `applyTopupWebhook`, and a new package-order repair pass through `applyPackageWebhook`
  (the webhook's own claim/grant paths; no second path). Amount mismatch alerts and applies nothing. Unreachable: nothing, retried next day.
- Files: `src/core/billing/payments.ts`, `topups.ts`, `package-orders.ts`, `test/helpers/kashier.ts`, `docs/billing.md`.
- Tests: stuck top-up confirmed paid credits once (repair racing the webhook credits once); unreachable credits nothing and is retried;
  mismatch alerts and credits nothing; stuck package order granted once; several successful payments for one order: nothing, alert.

## Item b: Kashier card-refund API behind `KASHIER_REFUNDS_ENABLED` (default off)
- Off: `refund()` is never called; behaviour identical to today (manual payout).
- On: `refunds.ts` sends the card-refundable portion to Kashier (`PUT /v3/orders/{kashierOrderId}`, `apiOperation: REFUND`). Only a confirmed
  SUCCESS marks it refunded. Wallet debit and ledger rows written once (existing `refund:<id>:<n>` refs). Failure or an uncertain answer: manual_payout.
- Kashier documents no idempotency key: the request id travels in `reason`, a `card_refunds` row is written BEFORE the call, and a refund
  webhook is reconciled against it (never a second wallet debit). See the ledger for the full rulings.
- Files: `payments.ts`, `refunds.ts`, new D1 migration, `topups.ts` webhook reconciliation, `env.ts`, `docs/billing.md`, `docs/launch/README.md`.
- Tests: success, rejected -> manual, timeout -> manual without double debit, replayed refund webhook once, switch off -> as today.

## Item c: package gating of shared-number joins
- Rule (docs are silent): an active or trialing entitlement whose package has `shared_number = 1` (migration 0012, default 1).
- `joinShared` refuses `package_required` (HTTP 402); contract additive; web shows ar+en reason; lapsed members keep replying but cannot
  start new conversations. Docs: `billing.md`, `shared-number.md`, help guides 03/09 ar+en.

## Review focus
Exactly-once on every money write; fail closed on every uncertain answer; no PII in logs; Kashier shapes marked NOT VERIFIED where undocumented.
