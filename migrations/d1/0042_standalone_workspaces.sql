-- CHAT-SA-2: standalone workspaces (Ebda Chat without an Ebda Store). A second workspace KIND next to the Store-linked one, with its own id space `sw_<26 base32>`.
-- Additive only (rollback-safe): new columns with defaults, new tables, BEFORE triggers that write nothing (D1 `meta.changes` counts trigger-written rows, see test/d1-changes-guard.test.ts).
-- Tonight nothing reads or writes the new tables except `createStandaloneWorkspace` (no caller until PR-3); every existing row is kind 'store'.
ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store', 'standalone'));
ALTER TABLE workspaces ADD COLUMN country TEXT NOT NULL DEFAULT 'EG';

-- D1/SQLite cannot add a two-column CHECK through ALTER: `kind = 'standalone'` iff the id starts with 'sw_' is checked by triggers. substr() is case-sensitive (LIKE is not).
CREATE TRIGGER workspaces_kind_id_insert BEFORE INSERT ON workspaces
WHEN (NEW.kind = 'standalone') <> (substr(NEW.id, 1, 3) = 'sw_')
BEGIN SELECT RAISE(ABORT, 'workspace_kind_id_mismatch'); END;
CREATE TRIGGER workspaces_kind_id_update BEFORE UPDATE OF id, kind ON workspaces
WHEN (NEW.kind = 'standalone') <> (substr(NEW.id, 1, 3) = 'sw_')
BEGIN SELECT RAISE(ABORT, 'workspace_kind_id_mismatch'); END;

-- Membership of a standalone workspace: keyed by the accounts user id (the token `sub`), read live on every request (never a token claim). Store workspaces never have rows here.
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members (user_id, status);
CREATE TRIGGER workspace_members_standalone_only BEFORE INSERT ON workspace_members
WHEN substr(NEW.workspace_id, 1, 3) <> 'sw_'
BEGIN SELECT RAISE(ABORT, 'workspace_members_standalone_only'); END;
CREATE TRIGGER workspace_members_standalone_only_update BEFORE UPDATE OF workspace_id ON workspace_members
WHEN substr(NEW.workspace_id, 1, 3) <> 'sw_'
BEGIN SELECT RAISE(ABORT, 'workspace_members_standalone_only'); END;

-- Operator-minted single-use creation codes (only the hash is stored).
CREATE TABLE standalone_invites (
  code_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  used_workspace_id TEXT,
  revoked_at INTEGER,
  note TEXT
);
CREATE INDEX standalone_invites_created ON standalone_invites (created_at);

-- Creation-attempt log for the per-user / per-IP rate limit (ip is a hash). Pruned daily (rows older than 2 days).
CREATE TABLE workspace_creations (
  user_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX workspace_creations_user ON workspace_creations (user_id, at);
CREATE INDEX workspace_creations_ip ON workspace_creations (ip_hash, at);
