-- Packages: who set a subscription (source), early renewals queued behind the running period, self-serve package orders, and the
-- last Store plan event applied per workspace.
-- `source`: a row that exists before this migration was written by hand (an operator or a test), so it is operator-owned: the Store plan
-- never overwrites it while it runs.
ALTER TABLE workspace_subscriptions ADD COLUMN source TEXT;
UPDATE workspace_subscriptions SET source = 'operator' WHERE source IS NULL;
-- Paid-for periods that start when the running one ends (an early renewal of the same package). One payment = one queued period.
ALTER TABLE workspace_subscriptions ADD COLUMN queued_periods INTEGER NOT NULL DEFAULT 0 CHECK (queued_periods >= 0);

-- The package a Store plan with WhatsApp included maps to. Free; 100 AI credits a month.
INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('store-included', 'Included with the store plan', 0, 100, 1, 0);

-- One row per checkout. order_id is the provider's merchantOrderId. The paid transition, the grant and `granted_at` happen in ONE D1
-- batch, so `status = 'paid' AND granted_at IS NULL` only exists if a batch never ran (the daily repair then grants it and alerts).
-- provider_ref (the provider transaction) is unique. `queued` = the order bought an early renewal (a queued period), not a new period.
CREATE TABLE package_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'refunded', 'charged_back')),
  provider_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  granted_at INTEGER,
  queued INTEGER NOT NULL DEFAULT 0,
  -- Which period the order paid for: owns_running = 1 for the order that owns the running period; queued_seq = its place (1, 2, ...) among
  -- the periods queued behind it. An order with neither paid for a period that has already ended.
  owns_running INTEGER NOT NULL DEFAULT 0,
  queued_seq INTEGER,
  -- Set when a full refund / chargeback cancelled the plan: the period whose unused AI credits must be zeroed (retried until it is done).
  revoked_period_start INTEGER,
  refunded_minor INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX package_orders_provider_ref ON package_orders (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX package_orders_workspace ON package_orders (workspace_id, created_at);
CREATE INDEX package_orders_open ON package_orders (status, created_at) WHERE status IN ('pending', 'paid');

-- Last store.plan_changed seen for a workspace: the stale/replay guard AND what the Store plan says now (so a store whose bought
-- package lapses falls back to it). `claimed` is 1 only inside the batch that applies the event.
CREATE TABLE store_plan_applied (
  workspace_id TEXT PRIMARY KEY,
  effective_at INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  includes_whatsapp INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  period_end INTEGER,
  claimed INTEGER NOT NULL DEFAULT 0
);

-- One row per provider refund transaction applied to a package order (idempotency key = the refund's own transaction id).
-- `applied` is 0 only inside the batch that applies it; `shortened` = a partial refund shortened the running period.
CREATE TABLE package_refunds (
  refund_ref TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES package_orders(order_id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  at INTEGER NOT NULL,
  period_start INTEGER,
  applied INTEGER NOT NULL DEFAULT 0,
  shortened INTEGER NOT NULL DEFAULT 0,
  -- The fraction of the period's unused credits this refund takes back (refunded / still-unrefunded), fixed when the refund was decided.
  frac_num INTEGER,
  frac_den INTEGER
);

-- Provider deliveries that could not be confirmed with the provider yet (details not queryable, outage). Kept so the daily pass can
-- re-confirm them through the same path as a live webhook even if the provider never retries. The signed body is the same data the
-- provider already sent us; rows are deleted 30 days after they resolve.
CREATE TABLE unconfirmed_webhooks (
  event_key TEXT PRIMARY KEY,
  raw_body TEXT NOT NULL,
  signature TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_reason TEXT,
  resolved_at INTEGER
);
CREATE INDEX unconfirmed_webhooks_open ON unconfirmed_webhooks (first_seen) WHERE resolved_at IS NULL;
