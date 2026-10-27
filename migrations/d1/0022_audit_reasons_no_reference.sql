-- W2 final review (PR #37). Additive only.

-- AUDIT-RETENTION-1 / review item 6: free text an operator types (the reason for a data-subject export) must not sit in the append-only audit_log for ever,
-- where a phone number in it could never be removed. It lives here instead: deletable, phone numbers masked on the way in, removed with the workspace on offboarding.
CREATE TABLE audit_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX audit_reasons_workspace ON audit_reasons (workspace_id, id);

-- DUP-REF-REQUIRED-1 / review item 7: an InstaPay request confirmed WITHOUT a bank reference (the operator ticked "the proof shows no number" and gave a reason).
-- Two of these for the same workspace and amount within 7 days hold the second one.
ALTER TABLE instapay_requests ADD COLUMN no_reference INTEGER NOT NULL DEFAULT 0;
CREATE INDEX instapay_requests_no_reference ON instapay_requests (workspace_id, amount_minor, decided_at) WHERE no_reference = 1;
