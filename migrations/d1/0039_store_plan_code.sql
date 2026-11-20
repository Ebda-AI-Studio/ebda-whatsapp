-- CHAT-QA-13: the Store's plan code (store.plan_changed `planCode`) is kept with the applied event so the wallet can show the plan by the Store's own
-- name instead of a raw package id. Additive, nullable: a row written before this migration has no code and the wallet shows the package name.
ALTER TABLE store_plan_applied ADD COLUMN plan_code TEXT;
