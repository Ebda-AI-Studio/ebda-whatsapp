-- W2 security/ops integration (AUDIT-REASONS-1). operator_view_log (0025) is append-only, so the operator's typed reason moves to the deletable audit_reasons (0022) and the
-- immutable row carries `reason_id`. The old `reason` column stays (forward-only migrations, NOT NULL) and is written only with the constant 'see reason_id'; rows that
-- exist keep their text (the view-as feature is not live yet: no production rows).
ALTER TABLE operator_view_log ADD COLUMN reason_id INTEGER;
