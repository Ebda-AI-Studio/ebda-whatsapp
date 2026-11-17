-- Smart Layer assistant (plan 4): platform-wide switches that must change WITHOUT a deploy (global kill, Chat kill, global mode cap, killed tools),
-- and the help-index bookkeeping (corpus hash + vector ids, so a changed corpus is re-indexed once and stale vectors are removed).
-- A switch is read on EVERY turn and again at apply time (never cached): NEVER-stale class, no TTL. No personal data.
CREATE TABLE platform_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
