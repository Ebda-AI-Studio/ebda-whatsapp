-- W2 final review. offboarding_log is immutable and must hold no free text: the operator's reason goes to the deletable audit_reasons (0022) and the log row points at
-- it by id. The old `reason` column stays (additive-only migrations) but is never written again.
ALTER TABLE offboarding_log ADD COLUMN reason_id INTEGER;
