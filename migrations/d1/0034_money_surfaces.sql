-- Merchant money surfaces (self-service A9 Chat half, A21, A22). Three additive tables; nothing here moves money by itself.

-- Server-issued, single-use confirmation tokens for money actions. Only the SHA-256 of the token is stored; `payload_hash` binds it to the exact figures
-- the merchant was shown, so an edited or stale payload is refused. `used_at` is set by one conditional UPDATE (a replay finds it set).
CREATE TABLE money_confirmations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('number_funding', 'yearly_refund_request', 'credit_pack')),
  payload_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX money_confirmations_open ON money_confirmations (workspace_id, user_id, action) WHERE used_at IS NULL;
CREATE INDEX money_confirmations_expiry ON money_confirmations (expires_at);

-- A merchant's REQUEST to cancel a yearly package and have the unused whole months refunded. `id` is the confirmation id (the idempotency key). The figures are
-- what the merchant confirmed; the operator still runs executeYearlyRefund (which recomputes them) and sends any card refund by hand.
CREATE TABLE yearly_refund_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  order_id TEXT NOT NULL,
  unused_months INTEGER NOT NULL CHECK (unused_months > 0),
  gross_minor INTEGER NOT NULL CHECK (gross_minor > 0),
  debt_settled_minor INTEGER NOT NULL CHECK (debt_settled_minor >= 0),
  refund_minor INTEGER NOT NULL CHECK (refund_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'executed')),
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  executed_by TEXT,
  executed_at INTEGER
);
CREATE UNIQUE INDEX yearly_refund_requests_one_pending ON yearly_refund_requests (workspace_id) WHERE state = 'pending';
CREATE INDEX yearly_refund_requests_state ON yearly_refund_requests (state, created_at);

-- A card purchase of AI credits. Credited ONLY from a verified provider webhook (or the provider's inquiry), once per payment: the order binds to one
-- transaction id and the credit ledger row's ref is `credit-pack:<transaction id>`. `order_id` = 'cp_' + the confirmation id (the idempotency key).
CREATE TABLE credit_orders (
  order_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  state TEXT NOT NULL CHECK (state IN ('pending', 'paid', 'failed', 'expired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  transaction_id TEXT,
  paid_at INTEGER
);
CREATE INDEX credit_orders_workspace ON credit_orders (workspace_id, created_at);
CREATE INDEX credit_orders_pending ON credit_orders (state, created_at) WHERE state = 'pending';
