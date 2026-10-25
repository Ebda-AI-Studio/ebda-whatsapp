-- InstaPay billing (behind INSTAPAY_BILLING_ENABLED): a merchant pays a package or a wallet top-up by InstaPay transfer, uploads the proof,
-- and an operator confirms. The grant goes through the SAME paths as a card payment: a `package_orders` row (-> grantOrder) or a `topups` row
-- (-> credit) is written with the request, with provider 'instapay', so the Kashier repair and expiry passes leave them alone.
ALTER TABLE package_orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'kashier';
ALTER TABLE topups ADD COLUMN provider TEXT NOT NULL DEFAULT 'kashier';

-- id = the order id of the package_orders / topups row. `reference` is the human-typable code the merchant writes in the transfer note.
-- awaiting_proof -> under_review (proof uploaded in time) -> confirmed | rejected ; awaiting_proof -> expired (48 h, daily pass).
-- A proof already uploaded never expires on the clock: it waits for a person (the overdue alert watches it).
CREATE TABLE instapay_requests (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('package', 'topup')),
  package_id TEXT REFERENCES packages(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'EGP',
  state TEXT NOT NULL CHECK (state IN ('awaiting_proof', 'under_review', 'confirmed', 'rejected', 'expired')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  proof_key TEXT,
  proof_mime TEXT,
  proof_bytes INTEGER,
  proof_at INTEGER,
  -- Maker-checker: the requester never decides; at or above ADJUSTMENT_APPROVAL_MINOR two different operators are needed.
  first_approver TEXT,
  first_approved_at INTEGER,
  decided_by TEXT,
  decided_at INTEGER,
  reject_reason TEXT,
  granted_at INTEGER,
  overdue_alerted_at INTEGER
);
CREATE INDEX instapay_requests_state ON instapay_requests (state, created_at);
CREATE INDEX instapay_requests_workspace ON instapay_requests (workspace_id, created_at);
