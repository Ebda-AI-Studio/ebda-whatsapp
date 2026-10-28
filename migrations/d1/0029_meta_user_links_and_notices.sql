-- Final review I5 (LEGAL-DELETE-1, second form).
-- 1. WHO connected a WABA, recorded SERVER-side at Embedded Signup from the exchanged token (Graph debug_token), as a keyed hash (HMAC under ERASURE_HMAC_KEY, label
--    `meta-user`). Meta's data-deletion callback finds a person's mappings here; it erases THE MAPPING, not the merchant's numbers.
CREATE TABLE waba_signup_users (
  waba_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (waba_id, user_hash)
);
CREATE INDEX waba_signup_users_user ON waba_signup_users (user_hash);
CREATE INDEX waba_signup_users_workspace ON waba_signup_users (workspace_id);
-- The browser-reported `fb_user_id` (0026) was never verified and is not used any more: erase what it holds (it is a person's id).
UPDATE waba_credentials SET fb_user_id = NULL WHERE fb_user_id IS NOT NULL;

-- 2. An owner-visible notice per workspace (a person who connected a number removed the app: the owner or an operator confirms any disconnect).
CREATE TABLE workspace_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE UNIQUE INDEX workspace_notices_open ON workspace_notices (workspace_id, kind, ref) WHERE resolved_at IS NULL;

-- 3. A durable queue for the deletion requests: `queued` rows are retried by the daily sweep, with a count.
ALTER TABLE meta_deletion_requests ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meta_deletion_requests ADD COLUMN last_attempt_at INTEGER;
