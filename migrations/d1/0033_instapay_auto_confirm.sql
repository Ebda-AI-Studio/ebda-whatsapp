-- InstaPay auto-confirm (plan 2026-11-14, rulings INSTAPAY-1..7, INSTAPAY-CLEAN-1): the AI only reads the receipt into a typed object, plain code
-- decides, a full match confirms by itself behind a first-payment cap, a platform-global duplicate index (the shared D1 bound as INSTAPAY_DEDUPE_DB)
-- and a kill switch. A "not received" revert puts the plan on a 48 h unpaid grace and removes the credits that payment granted and nobody used.
-- Additive only: nothing here is dropped or renamed. Money is integer piastres. `extracted_json` holds amount, reference, date and handle only (no payer data).

CREATE TABLE instapay_auto_confirmations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES instapay_requests(id),
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending_decision', 'auto_confirmed', 'needs_human', 'reverted', 'failed')),
  verdict TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  amount_minor INTEGER,
  expected_amount_minor INTEGER,
  is_first_payment INTEGER,
  extracted_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  confirmed_at INTEGER,
  digest_sent_at INTEGER,
  reverted_at INTEGER,
  reverted_by TEXT,
  grace_until INTEGER,
  credits_removed_minor INTEGER,
  credits_used_minor INTEGER,
  ai_credits_removed INTEGER,
  ai_credits_used INTEGER,
  waiting_notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX instapay_auto_state ON instapay_auto_confirmations (state, digest_sent_at);
CREATE INDEX instapay_auto_workspace_idx ON instapay_auto_confirmations (workspace_id, created_at);

ALTER TABLE instapay_requests ADD COLUMN reverted_at INTEGER;

-- Global mode: key 'mode' = off | shadow | live. No row = off. Read from the database on every decision (a money switch is never cached).
CREATE TABLE instapay_auto_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-workspace switch: a row with disabled_at set means auto-confirm is off for that workspace (a revert writes one). No row = on (when the global mode allows).
CREATE TABLE instapay_auto_workspace (
  workspace_id TEXT PRIMARY KEY,
  disabled_at INTEGER,
  actor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The 48 h unpaid-grace marker of a reverted package payment: the plan stays in effect until this instant (the revert also shortens the period to it), and a new
-- confirmed payment clears it.
ALTER TABLE workspace_subscriptions ADD COLUMN payment_unconfirmed_until INTEGER;
