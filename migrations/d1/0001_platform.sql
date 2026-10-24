-- Control plane: which workspace owns which WhatsApp number. No message content here.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE phone_numbers (
  phone_number_id TEXT PRIMARY KEY,
  waba_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  display_phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disconnected'))
);

CREATE INDEX phone_numbers_waba ON phone_numbers (waba_id);
