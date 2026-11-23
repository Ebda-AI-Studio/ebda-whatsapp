-- Ahmad 2026-11-19: Chat packages are named by SIZE (their monthly AI replies), never Starter / Growth / Pro (those collide with the Store's plan names).
-- Only the display text changes: ids, prices, credits, limits and periods are untouched. The apps derive the name from the credits (src/core/billing/package-names.ts);
-- this keeps the stored text (operator lists, audit joins, exports) in step. Additive: the old Worker only ever shows `name`.
UPDATE packages SET name = 'Chat 300 AI replies' WHERE id = 'starter';
UPDATE packages SET name = 'Chat 1,500 AI replies' WHERE id = 'growth';
UPDATE packages SET name = 'Chat 5,000 AI replies' WHERE id = 'pro';
UPDATE packages SET name = 'Chat 300 AI replies (yearly)' WHERE id = 'starter-yearly';
UPDATE packages SET name = 'Chat 1,500 AI replies (yearly)' WHERE id = 'growth-yearly';
UPDATE packages SET name = 'Chat 5,000 AI replies (yearly)' WHERE id = 'pro-yearly';
