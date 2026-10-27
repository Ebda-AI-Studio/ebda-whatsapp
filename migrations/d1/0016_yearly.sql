-- P2 yearly billing (WA-PRICE-1a): a package has a billing period of 1 or 12 months. A yearly package is paid once for 12 months (9 x the monthly price),
-- carries the SAME limits and the SAME AI credits per MONTH as its monthly twin, and the credits are granted monthly inside the period (never 12x upfront).
ALTER TABLE packages ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1 CHECK (period_months IN (1, 12));

INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at, max_members, feat_campaigns, feat_order_in_chat, feat_api, priority_support, period_months) VALUES
  ('starter-yearly', 'Starter (yearly)', 621000, 300, 1, 0, 2, 0, 0, 0, 0, 12),
  ('growth-yearly', 'Growth (yearly)', 1341000, 1500, 1, 0, 5, 1, 1, 0, 0, 12),
  ('pro-yearly', 'Pro (yearly)', 3141000, 5000, 1, 0, 15, 1, 1, 1, 1, 12);

-- What a package order is, decided when it is created (server-side) and never by the client:
--  period_months  the length of the period THIS order bought (so a queued 12-month period rolls as 12 months whatever the package row says later);
--  kind           'purchase' (a new period, or a renewal of the same package queued behind the running one), 'upgrade' (WA-YEARLY-SWITCH-2: the prorated
--                 difference to a higher yearly package, applied at once to the running period, same end) or 'queued_switch' (a downgrade: paid in full,
--                 queued to start at the next renewal, no refund of the running package);
--  from_package   the package an upgrade / queued switch was bought from;
--  period_owner   for an upgrade: the order that owns the period it belongs to (refunds are measured over all the orders of a period).
ALTER TABLE package_orders ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1;
ALTER TABLE package_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'purchase' CHECK (kind IN ('purchase', 'upgrade', 'queued_switch'));
ALTER TABLE package_orders ADD COLUMN from_package TEXT;
ALTER TABLE package_orders ADD COLUMN period_owner TEXT;
-- The period an upgrade / queued switch was PRICED against. The grant applies only while the subscription is still in exactly that period (a stale quote paid after
-- the period rolled is never granted at the old pro-rata price; it stays paid-but-ungranted and alerts a person).
ALTER TABLE package_orders ADD COLUMN quoted_period_start INTEGER;
ALTER TABLE package_orders ADD COLUMN quoted_period_end INTEGER;

-- One executed yearly refund per period owner (the operator's cancel + refund, debt first): the stored figures make a replay return the same answer and
-- redo only the idempotent steps. cash_minor = what still has to be sent back through the provider's dashboard (0 = no money goes out).
CREATE TABLE package_refund_plans (
  order_id TEXT PRIMARY KEY REFERENCES package_orders(order_id),
  workspace_id TEXT NOT NULL,
  shortened_months INTEGER NOT NULL,
  debt_settled_minor INTEGER NOT NULL,
  cash_minor INTEGER NOT NULL,
  period_start INTEGER NOT NULL,
  new_period_end INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  -- 1 once the debt part has been credited to the workspace wallet (a fixed, idempotent ref). The daily pass posts the ones still 0, so an applied plan whose wallet call failed heals.
  debt_posted INTEGER NOT NULL DEFAULT 0
);

-- What a partial refund of a YEARLY order cut, in money: months cut x the monthly value in effect WHEN IT WAS MADE. Later refunds (after an upgrade changed the rate) are
-- measured against what the earlier cuts really consumed, never against today's rate.
ALTER TABLE package_refunds ADD COLUMN cut_value_minor INTEGER NOT NULL DEFAULT 0;
