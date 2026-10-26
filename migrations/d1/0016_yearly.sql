-- P2 yearly billing (WA-PRICE-1a): a package has a billing period of 1 or 12 months. A yearly package is paid once for 12 months (9 x the monthly price),
-- carries the SAME limits and the SAME AI credits per MONTH as its monthly twin, and the credits are granted monthly inside the period (never 12x upfront).
ALTER TABLE packages ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1 CHECK (period_months IN (1, 12));

INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, period_months) VALUES
  ('starter-yearly', 'Starter (yearly)', 621000, 300, 1, 0, 2, 0, 0, 0, 0, 12),
  ('growth-yearly', 'Growth (yearly)', 1341000, 1500, 1, 0, 5, 1, 1, 0, 0, 12),
  ('pro-yearly', 'Pro (yearly)', 3141000, 5000, 1, 0, 15, 1, 1, 1, 1, 12);
