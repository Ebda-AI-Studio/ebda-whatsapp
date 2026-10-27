-- W2-META / W2-OPS. Number health (a state machine fed by Meta's quality / account webhooks) and the operator kill switch.
-- NEVER-stale gates: every write path that changes health or suspension writes this table AND the workspace's own copy (Durable Object); nothing here is cached.

ALTER TABLE phone_numbers ADD COLUMN health_state TEXT NOT NULL DEFAULT 'green' CHECK (health_state IN ('green', 'yellow', 'red', 'restricted'));
ALTER TABLE phone_numbers ADD COLUMN health_reason TEXT;
ALTER TABLE phone_numbers ADD COLUMN health_at INTEGER;

-- The platform number belongs to no workspace, so its health lives on its own row (no new member joins it unless it is green).
ALTER TABLE shared_numbers ADD COLUMN health_state TEXT NOT NULL DEFAULT 'green' CHECK (health_state IN ('green', 'yellow', 'red', 'restricted'));
ALTER TABLE shared_numbers ADD COLUMN health_reason TEXT;
ALTER TABLE shared_numbers ADD COLUMN health_at INTEGER;

-- Suspended: all sends and the agent stop, reading stays. integrations_revoked_at: every integrator token issued at or before it is refused.
ALTER TABLE workspaces ADD COLUMN suspended_at INTEGER;
ALTER TABLE workspaces ADD COLUMN suspended_reason TEXT;
ALTER TABLE workspaces ADD COLUMN integrations_revoked_at INTEGER;

-- Every operator kill-switch action, with who and why. Append-only: a row can never be changed or removed.
CREATE TABLE operator_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('suspend', 'unsuspend', 'pause_campaigns', 'evict_shared', 'readmit_shared', 'revoke_integrations')),
  workspace_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) >= 5),
  detail TEXT
);
CREATE INDEX operator_actions_workspace ON operator_actions (workspace_id, at);
CREATE TRIGGER operator_actions_no_update BEFORE UPDATE ON operator_actions BEGIN SELECT RAISE(ABORT, 'operator_actions are append-only'); END;
CREATE TRIGGER operator_actions_no_delete BEFORE DELETE ON operator_actions BEGIN SELECT RAISE(ABORT, 'operator_actions are append-only'); END;
