-- Final review (campaign abuse): the new-workspace campaign cap is counted per OWNER (the Store's ownerUserId, across their workspaces) and per SHARED NUMBER, not only per workspace.
-- `workspace_owners` is fed by the Store's `store.linked` / `store.plan_changed` events. `new_cap_usage` holds the recipients a still-capped workspace reserved, one row per page
-- (`ref` makes a retried page idempotent); a row only matters for 24 h and is deleted after two days by the daily pass.
CREATE TABLE workspace_owners (
  workspace_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX workspace_owners_owner ON workspace_owners (owner_user_id);
CREATE TABLE new_cap_usage (
  ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT,
  phone_number_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX new_cap_usage_owner ON new_cap_usage (owner_user_id, at) WHERE owner_user_id IS NOT NULL;
CREATE INDEX new_cap_usage_number ON new_cap_usage (phone_number_id, at);
CREATE INDEX new_cap_usage_workspace ON new_cap_usage (workspace_id);
