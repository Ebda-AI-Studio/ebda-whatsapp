-- CHAT-SA-4 (review): a staff invitation is NOT a membership. The invitee becomes active seated staff only by accepting while signed in as the invited identity; until then they have no
-- access and no seat. The owner sees what they typed (first name + email stored here), never the accounts profile of an invitee who has not accepted.
-- Additive only. Both tables carry a workspace id and are deleted with the workspace (email is personal data).
CREATE TABLE workspace_invitations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  decided_at INTEGER,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_invitations_user ON workspace_invitations (user_id, status);
CREATE TRIGGER workspace_invitations_standalone_only BEFORE INSERT ON workspace_invitations
WHEN substr(NEW.workspace_id, 1, 3) <> 'sw_'
BEGIN SELECT RAISE(ABORT, 'workspace_invitations_standalone_only'); END;

-- Invite reservations for the per-workspace / per-inviter daily caps: one row per attempt, written by ONE conditional INSERT before the accounts call. Pruned daily.
CREATE TABLE invite_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  inviter TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX invite_attempts_ws ON invite_attempts (workspace_id, at);
CREATE INDEX invite_attempts_inviter ON invite_attempts (inviter, at);
