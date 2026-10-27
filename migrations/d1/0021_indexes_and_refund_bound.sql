-- W2-D1 (M-057, M-138).
-- Indexes on the workspace_id lookups the code issues that had none (they scanned the table).
CREATE INDEX IF NOT EXISTS phone_numbers_workspace ON phone_numbers (workspace_id, status);
CREATE INDEX IF NOT EXISTS refund_requests_workspace ON refund_requests (workspace_id, state, created_at);
CREATE INDEX IF NOT EXISTS billing_audit_workspace ON billing_audit (workspace_id, id);

-- Ruling MONEY-FACT-1: an external money fact is never rejected. There is NO trigger that aborts a refund write (a chargeback arriving after a partial refund must still debit the
-- wallet / revoke the package). `refunded_minor` is clamped by every writer (MIN(amount_minor, ...), pinned by test/d1-indexes-bounds.test.ts); whatever lies beyond the charge is
-- recorded in full here, per event, and alerted (refund_exceeds_charge, P1).
ALTER TABLE card_refunds ADD COLUMN over_charge_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE package_refunds ADD COLUMN over_charge_minor INTEGER NOT NULL DEFAULT 0;
