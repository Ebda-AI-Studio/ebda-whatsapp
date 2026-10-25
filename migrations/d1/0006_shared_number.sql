-- Phase 8.2: the shared platform number. Several stores send from one number and customers answer it, so an inbound message is routed by
-- who last wrote to that customer, never by number ownership. No message content here, and no raw phone number: a customer is a keyed hash
-- (HMAC over the WhatsApp id with a platform secret), so a leaked table cannot be turned back into numbers.
CREATE TABLE shared_numbers (
  phone_number_id TEXT PRIMARY KEY,
  waba_id TEXT NOT NULL,
  display_phone TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE shared_number_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  phone_number_id TEXT NOT NULL REFERENCES shared_numbers(phone_number_id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'left')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, phone_number_id)
);
CREATE INDEX shared_number_members_number ON shared_number_members (phone_number_id, status);

-- Who last wrote to which customer from the shared number. `chosen_at` is set when the customer picked this store from the
-- "which store?" list (Ruling WA-SHARED-PIN-1): it settles later replies until another store writes to that customer again.
CREATE TABLE shared_routes (
  phone_number_id TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  order_ref TEXT,
  chosen_at INTEGER,
  PRIMARY KEY (phone_number_id, customer_key, workspace_id)
);
CREATE INDEX shared_routes_lookup ON shared_routes (phone_number_id, customer_key, last_at DESC);
CREATE INDEX shared_routes_workspace ON shared_routes (workspace_id, customer_key);

-- Which store sent a message from the shared number, so Meta's delivery statuses (which carry only the message id) reach the sender
-- and nobody else (Ruling WA-SHARED-SENT-1). Pruned after 35 days.
CREATE TABLE shared_sent (
  wamid TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  customer_key TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX shared_sent_workspace ON shared_sent (workspace_id, customer_key);
CREATE INDEX shared_sent_at ON shared_sent (at);
