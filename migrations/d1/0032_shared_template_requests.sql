-- Plan 2 task 12 (A18): a store on the SHARED number cannot create templates on the platform WABA, but it can ask the platform team for a utility or
-- authentication one. Marketing is not requestable (WA-SHARED-NOCAMP-1: marketing is never sendable from the shared number). One row per ask: the template
-- the store wants (a name, a language, the text), who asked, and whether the team made it. No customer data, no phone numbers.
CREATE TABLE shared_template_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('UTILITY', 'AUTHENTICATION')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX shared_template_requests_workspace ON shared_template_requests (workspace_id, status);
CREATE INDEX shared_template_requests_open ON shared_template_requests (status, created_at);
