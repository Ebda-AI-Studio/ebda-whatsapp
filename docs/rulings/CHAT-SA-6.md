# CHAT-SA-6

**Ruling CHAT-SA-6 - Standalone billing = Chat purchases only (packages via Kashier card or InstaPay, EGP wallet, AI packs); no `store-included`, no trial (CHAT-ENABLE-1: enabling starts no trial clock); the first InstaPay payment of a standalone workspace always goes to a person (the existing "no plan" rule), card payments unchanged.** Evidence: `docs/billing.md:51,85,149,166`; `store-plan.ts` only writes from Store events, which a standalone workspace never receives. Cost if wrong: first InstaPay payments from standalone clients take up to one business day to confirm.

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
