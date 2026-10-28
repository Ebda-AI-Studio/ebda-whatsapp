-- T35 (W2-SUPPORT): every request an operator makes "as the merchant" (X-View-As-Merchant) is written here BEFORE it is served. Append-only. No body, no query string,
-- no phone number: the route is the request path with long digit segments (a phone) replaced by :id.
-- INTEGRATION FLAG: when the workspace audit_log of W2-ERASE (T8) lands, either keep this table as the operator-access trail or fold its rows into audit_log.
CREATE TABLE operator_view_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX operator_view_log_workspace ON operator_view_log (workspace_id, id);
CREATE TRIGGER operator_view_log_no_update BEFORE UPDATE ON operator_view_log BEGIN SELECT RAISE(ABORT, 'operator_view_log is append-only'); END;
CREATE TRIGGER operator_view_log_no_delete BEFORE DELETE ON operator_view_log BEGIN SELECT RAISE(ABORT, 'operator_view_log is append-only'); END;
