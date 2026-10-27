-- W2-ERASE (B3, T8, M-093). Two durable records.

-- An erasure RECORD: a restore or backup import consults it so an erased contact never comes back. The subject is a keyed hash
-- (HMAC-SHA-256 over workspace + WhatsApp id, key derived from TOKEN_ENC_KEY), never the phone number, bound to the workspace.
-- It lives in D1, not in the Durable Object, so it survives the loss of the very object a disaster-recovery restore replaces.
CREATE TABLE erasure_records (
  workspace_id TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  erased_at INTEGER NOT NULL,
  erased_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, subject_hash)
) WITHOUT ROWID;

-- Who did what, to which ids, when. Staff, owner, operator and server-token writes; ids and counts only (never a phone number, a message,
-- a request body or a reason text). `status` is the HTTP status the action ended with (a denied write is evidence too). Append-only.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  workspace_id TEXT,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'staff', 'operator', 'integration', 'system')),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,
  status INTEGER NOT NULL DEFAULT 200
);
CREATE INDEX audit_log_workspace ON audit_log (workspace_id, id);
CREATE INDEX audit_log_actor ON audit_log (actor, id);
CREATE INDEX audit_log_action ON audit_log (action, id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
