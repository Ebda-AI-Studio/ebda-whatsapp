# Ruling WA-PACK-REFUND-1

**Decision:** A confirmed refund (or chargeback) of an AI credit pack expires the unused part of the pack automatically. Unused = the available balance beyond the period grant's own unused part (consumption draws on the grant first), capped at the refunded share of the pack (a partial refund takes its share only) and never below zero. The spent part is never reversed and never makes the balance negative; it stays in the `credit_pack_refunded` alert (`spentCredits`) for a person. The refund itself is recorded in full whatever the numbers (never aborted on an external money fact).

**Evidence:** `expirePackUnused` in `src/core/ai/credits.ts`, `applyCreditWebhook` in `src/core/billing/credit-packs.ts`, `test/credit-pack-refund.test.ts` (old code: 100 credits remain after a refund of a pack that was 30% spent).

**Cost if wrong:** with several packs bought, the attribution of spent credits to a pack is by balance (fungible), so a merchant refunded for one pack can lose unused credits that came from another pack of the same size; the money is the same and the total credits removed never exceed the refunded share.
