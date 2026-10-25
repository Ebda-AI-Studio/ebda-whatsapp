-- Card refunds (behind KASHIER_REFUNDS_ENABLED) and every refund the provider tells us about.
-- One row per refund transaction we know of, written BEFORE the provider is asked, so a refund webhook is matched to what we started
-- instead of being booked as a second debit. amount_minor is always in WALLET units (the top-up's amount_minor, never including the card fee).
--   source 'api'     we asked the provider to refund (state sending -> pending | succeeded | failed | uncertain)
--   source 'dashboard' an operator refunded in the provider's dashboard and linked it to a manual payout (state linked)
--   source 'webhook' a refund/chargeback we did not start (state succeeded); amount_minor is what the wallet was debited
--   source 'held'    a refund webhook whose id differs from an unconfirmed refund of ours for the same top-up and amount: NO wallet movement
--                    until an operator matches it to that refund (state held -> matched)
-- `calling` = one run won the guarded sending -> calling flip and is (or was) asking the provider: no other run may send the row.
-- sending / calling / pending / uncertain are OPEN: they reserve the top-up's refundable amount and keep the request in `processing`.
CREATE TABLE card_refunds (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES refund_requests(id),
  order_id TEXT NOT NULL REFERENCES topups(order_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  source TEXT NOT NULL CHECK (source IN ('api', 'dashboard', 'webhook', 'held')),
  state TEXT NOT NULL CHECK (state IN ('sending', 'calling', 'pending', 'uncertain', 'succeeded', 'failed', 'linked', 'held', 'matched')),
  kashier_refund_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Set when a signed, confirmed refund webhook named this refund (by its id): until then a refund of ours is still "unconfirmed".
  confirmed_at INTEGER,
  -- A held refund (source 'held'): the unconfirmed refund of ours it may be.
  candidate_id TEXT,
  note TEXT
);
CREATE UNIQUE INDEX card_refunds_provider_id ON card_refunds (kashier_refund_id) WHERE kashier_refund_id IS NOT NULL;
CREATE INDEX card_refunds_open ON card_refunds (state, created_at) WHERE state IN ('sending', 'calling', 'pending', 'uncertain');
CREATE INDEX card_refunds_order ON card_refunds (order_id);
CREATE INDEX card_refunds_request ON card_refunds (request_id);

-- A request's wallet debits are posted in one phase BEFORE any provider call; only when that phase is complete may the request be promoted to
-- a manual payout. Requests that existed before this column are final, so they default to complete.
ALTER TABLE refund_requests ADD COLUMN debit_complete INTEGER NOT NULL DEFAULT 1;

-- One run at a time: an approval (or a resume of one whose debit phase was cut short) claims the request with a lease (compare-and-swap).
ALTER TABLE refund_requests ADD COLUMN claimed_by TEXT;
ALTER TABLE refund_requests ADD COLUMN lease_until INTEGER;

-- The plan of an approval, recorded once BEFORE any money moves: a resume replays exactly these amounts, refs and transactions, whatever the
-- top-ups look like by then. kind 'card' = asks the provider; 'manual' = a manual payout (no card, switch off, or beyond the card top-ups).
CREATE TABLE refund_chunks (
  request_id TEXT NOT NULL REFERENCES refund_requests(id),
  n INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card', 'manual')),
  order_id TEXT,
  transaction_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (request_id, n)
);
