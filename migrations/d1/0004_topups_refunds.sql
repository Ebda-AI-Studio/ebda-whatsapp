-- Wallet top-ups (Phase 7.4), refund requests (WA-REFUND-1) and operator adjustments. The wallet is credited ONLY from a verified
-- provider webhook or the provider's own inquiry, never from the browser's return to our site.
CREATE TABLE topups (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  fee_minor INTEGER NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  state TEXT NOT NULL CHECK (state IN ('pending', 'paid', 'failed', 'expired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  transaction_id TEXT,
  paid_at INTEGER,
  refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0)
);
CREATE INDEX topups_workspace ON topups (workspace_id, created_at);
CREATE INDEX topups_pending ON topups (state, created_at) WHERE state = 'pending';

CREATE TABLE refund_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  note TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'rejected', 'processing', 'paid', 'manual_payout', 'failed', 'abandoned')),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT,
  card_refunded_minor INTEGER NOT NULL DEFAULT 0,
  manual_minor INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX refund_requests_state ON refund_requests (state, created_at);

-- Above the threshold an adjustment waits for a SECOND super admin (never the requester).
CREATE TABLE wallet_adjustments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  reason TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

