-- W2-OFFBOARD (B2, M-042). Workspace deletion with a cooling-off window. One row per workspace; no foreign key to workspaces, because the row
-- outlives the workspace (it is the proof that the deletion ran). `steps_done` is the resume point of an idempotent run.
CREATE TABLE offboarding (
  workspace_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'cancelled')),
  requested_by TEXT NOT NULL,
  requested_role TEXT NOT NULL CHECK (requested_role IN ('owner', 'operator')),
  reason TEXT,
  requested_at INTEGER NOT NULL,
  execute_after INTEGER NOT NULL,
  -- A wallet balance the requester agreed to give up (piasters); 0 = nothing was owed.
  write_off_minor INTEGER NOT NULL DEFAULT 0 CHECK (write_off_minor >= 0),
  started_at INTEGER,
  finished_at INTEGER,
  steps_done TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- The keyed-HMAC id the money records of this workspace moved to.
  pseudonym TEXT
);
CREATE INDEX offboarding_due ON offboarding (state, execute_after);

-- Every step of every deletion, who asked and who cancelled. Ids, step names and counts only: never a phone number or message text. Append-only.
CREATE TABLE offboarding_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  detail TEXT
);
CREATE INDEX offboarding_log_workspace ON offboarding_log (workspace_id, id);
CREATE TRIGGER offboarding_log_no_update BEFORE UPDATE ON offboarding_log BEGIN SELECT RAISE(ABORT, 'offboarding_log is append-only'); END;
CREATE TRIGGER offboarding_log_no_delete BEFORE DELETE ON offboarding_log BEGIN SELECT RAISE(ABORT, 'offboarding_log is append-only'); END;
