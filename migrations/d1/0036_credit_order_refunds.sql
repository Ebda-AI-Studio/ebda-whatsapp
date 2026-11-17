-- WA-PACK-REFUND-1 (review of #120): a provider refund of a credit pack is recorded FIRST, one row per refund (the PK is the refund's own key, so a redelivery is one row), whether or not
-- the pack was credited yet. Crediting (payment webhook or the repair job) reads these rows, so a refund that beats the payment is never lost. Money amounts and ids only.
CREATE TABLE credit_order_refunds (
  refund_ref TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  at INTEGER NOT NULL
);
CREATE INDEX credit_order_refunds_order ON credit_order_refunds (order_id);
CREATE INDEX credit_order_refunds_workspace ON credit_order_refunds (workspace_id, at);
