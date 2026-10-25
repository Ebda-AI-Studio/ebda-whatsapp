-- Packages: who set a subscription (source), self-serve package orders, and the last Store plan event applied per workspace.
ALTER TABLE workspace_subscriptions ADD COLUMN source TEXT;

-- The package a Store plan with WhatsApp included maps to. Free; AI credits per docs/billing.md (included tier).
INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('store-included', 'Included with the store plan', 0, 100, 1, 0);

-- One row per checkout. order_id is the provider's merchantOrderId. A paid order grants exactly once: the paid transition is a
-- conditional UPDATE, and provider_ref (the provider transaction) is unique.
CREATE TABLE package_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  provider_ref TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE UNIQUE INDEX package_orders_provider_ref ON package_orders (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX package_orders_workspace ON package_orders (workspace_id, created_at);

-- Last store.plan_changed applied to a workspace (stale and replay guard).
CREATE TABLE store_plan_applied (
  workspace_id TEXT PRIMARY KEY,
  effective_at INTEGER NOT NULL,
  event_id TEXT NOT NULL
);
