-- WA-PRICE-1: the approved packages and their limits. Limits live on the package row (the control plane) and travel to each workspace in
-- the entitlement event; a workspace decides every gate from its own copy, and no copy means DENY.
-- max_members counts the owner. Feature keys the UI shows (members, shared_inbox, order_confirmations, templates, ai_credits) are not columns:
-- shared_inbox / order_confirmations / templates are in every package, members and ai_credits come from their own columns.
ALTER TABLE packages ADD COLUMN max_members INTEGER NOT NULL DEFAULT 2 CHECK (max_members >= 1);
ALTER TABLE packages ADD COLUMN feat_campaigns INTEGER NOT NULL DEFAULT 0 CHECK (feat_campaigns IN (0, 1));
ALTER TABLE packages ADD COLUMN feat_order_in_chat INTEGER NOT NULL DEFAULT 0 CHECK (feat_order_in_chat IN (0, 1));
ALTER TABLE packages ADD COLUMN feat_api INTEGER NOT NULL DEFAULT 0 CHECK (feat_api IN (0, 1));
ALTER TABLE packages ADD COLUMN priority_support INTEGER NOT NULL DEFAULT 0 CHECK (priority_support IN (0, 1));

-- Prices in EGP minor units per month (Meta fees are separate: wallet or the merchant's own card). AI credits are per month.
INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support) VALUES
  ('starter', 'Starter', 69000, 300, 1, 0, 2, 0, 0, 0, 0),
  ('growth', 'Growth', 149000, 1500, 1, 0, 5, 1, 1, 0, 0),
  ('pro', 'Pro', 349000, 5000, 1, 0, 15, 1, 1, 1, 1);

-- The package a Store plan includes: two members, no paid-tier feature.
UPDATE packages SET max_members = 2, feat_campaigns = 0, feat_order_in_chat = 0, feat_api = 0, priority_support = 0 WHERE id = 'store-included';
