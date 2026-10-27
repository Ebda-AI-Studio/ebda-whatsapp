-- W2-META / W2-OPS. Number health (a state machine fed by Meta's quality / account webhooks) and the operator kill switch.
-- NEVER-stale gates: every write path that changes health or suspension writes this table AND the workspace's own copy (Durable Object); nothing here is cached.

ALTER TABLE phone_numbers ADD COLUMN health_state TEXT NOT NULL DEFAULT 'green' CHECK (health_state IN ('green', 'yellow', 'red', 'restricted'));
ALTER TABLE phone_numbers ADD COLUMN health_reason TEXT;
ALTER TABLE phone_numbers ADD COLUMN health_at INTEGER;
-- When (epoch ms) the newest signal applied to this number HAPPENED (Meta's own time): an older signal arriving later (Meta retries a 5xx for days) is dropped.
ALTER TABLE phone_numbers ADD COLUMN health_signal_at INTEGER NOT NULL DEFAULT 0;

-- The platform number belongs to no workspace, so its health lives on its own row (no new member joins it unless it is green).
ALTER TABLE shared_numbers ADD COLUMN health_state TEXT NOT NULL DEFAULT 'green' CHECK (health_state IN ('green', 'yellow', 'red', 'restricted'));
ALTER TABLE shared_numbers ADD COLUMN health_reason TEXT;
ALTER TABLE shared_numbers ADD COLUMN health_at INTEGER;
ALTER TABLE shared_numbers ADD COLUMN health_signal_at INTEGER NOT NULL DEFAULT 0;

-- The spike guard for the platform number: errors per number AND per member (10-minute buckets), so one abusive member is told apart from a number-wide problem.
CREATE TABLE shared_number_errors (
  phone_number_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (phone_number_id, workspace_id, bucket)
);

-- Suspended: all sends and the agent stop, reading stays. integrations_revoked_at: while set, EVERY integrator token of the store is refused (until the operator restores them).
ALTER TABLE workspaces ADD COLUMN suspended_at INTEGER;
ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
ALTER TABLE workspaces ADD COLUMN integrations_revoked_at INTEGER;

-- Every operator kill-switch action, with who and why. Append-only: a row can never be changed or removed.
CREATE TABLE operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('suspend', 'unsuspend', 'pause_campaigns', 'evict_shared', 'readmit_shared', 'revoke_integrations', 'restore_integrations')),
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) >= 5),
  detail TEXT
);
CREATE INDEX operator_actions_workspace ON operator_actions (workspace_id, at);
CREATE TRIGGER operator_actions_no_update BEFORE UPDATE ON operator_actions BEGIN SELECT RAISE(ABORT, 'operator_actions are append-only'); END;
CREATE TRIGGER operator_actions_no_delete BEFORE DELETE ON operator_actions BEGIN SELECT RAISE(ABORT, 'operator_actions are append-only'); END;
