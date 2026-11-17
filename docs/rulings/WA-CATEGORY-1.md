# Ruling WA-CATEGORY-1

**Decision:** A template whose category is unknown or empty locally is priced and held as MARKETING (the dearest) until Meta confirms the category; the existing category-change path (`adjustIfCategoryChanged`) then posts any difference as `meta_adjust`. Before, it defaulted to UTILITY, so an unknown marketing template took the utility path and the overdraft.

**Evidence:** `Billing.jobCategory` in `src/core/billing/engine.ts`; `test/billing-unknown-category.test.ts` (old code: category `utility`, estimate 100 instead of 250).

**Cost if wrong:** a genuinely utility template that is missing locally is held at the marketing rate and refused (`wallet_empty`) when the wallet cannot cover it, until its category is synced; the merchant is never overcharged because the charge is re-priced to Meta's billed category.
