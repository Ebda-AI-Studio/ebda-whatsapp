-- Card refunds (behind KASHIER_REFUNDS_ENABLED) and every refund the provider tells us about.
-- One row per refund transaction we know of, written BEFORE the provider is asked, so a refund webhook is matched to what we started
-- instead of being booked as a second debit. amount_minor is always in WALLET units (the top-up's amount_minor, never including the card fee).
--   source 'api'     we asked the provider to refund (state sending -> pending | succeeded | failed | uncertain)
--   source 'dashboard' an operator refunded in the provider's dashboard and linked it to a manual payout (state linked)
--   source 'webhook' a refund/chargeback we did not start (state succeeded); amount_minor is what the wallet was debited
-- sending / pending / uncertain are OPEN: they reserve the top-up's refundable amount and keep the request in `processing`.
CREATE TABLE card_refunds (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES refund_requests(id),
  order_id TEXT NOT NULL REFERENCES topups(order_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  source TEXT NOT NULL CHECK (source IN ('api', 'dashboard', 'webhook')),
  state TEXT NOT NULL CHECK (state IN ('sending', 'pending', 'uncertain', 'succeeded', 'failed', 'linked')),
  kashier_refund_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  note TEXT
);
CREATE UNIQUE INDEX card_refunds_provider_id ON card_refunds (kashier_refund_id) WHERE kashier_refund_id IS NOT NULL;
CREATE INDEX card_refunds_open ON card_refunds (state, created_at) WHERE state IN ('sending', 'pending', 'uncertain');
CREATE INDEX card_refunds_order ON card_refunds (order_id);
CREATE INDEX card_refunds_request ON card_refunds (request_id);
