-- WA-OWNER-FREE-1 (#115): the assistant's free turns are budgeted per OWNER (the Store's owner user id, across their workspaces), not only per workspace, so opening
-- more workspaces does not multiply the free budget. One row per free turn taken; only the last 24 h matter and a row older than that is deleted on the owner's next turn.
-- The id is the pseudonymous owner user id (or `ws:<workspaceId>` for a workspace without an owner row); no phone number, name or text.
CREATE TABLE assistant_owner_turns (
  owner_key TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX assistant_owner_turns_owner ON assistant_owner_turns (owner_key, at);
