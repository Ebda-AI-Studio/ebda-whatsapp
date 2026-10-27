-- W2 final review (AUDIT-REASONS-1, whole class). Additive only.
-- The append-only tables never hold an operator's typed text again: it goes to the deletable audit_reasons (0022) and the immutable row carries `reason_id`.
-- The old `reason` columns stay (migrations are forward-only and some are NOT NULL) and are written only with the constant 'see reason_id' (or NULL); rows that exist
-- keep their text (immutable by design: see the pre-launch residual in docs/erasure-and-audit.md).
ALTER TABLE operator_actions ADD COLUMN reason_id INTEGER;
ALTER TABLE billing_audit ADD COLUMN reason_id INTEGER;
ALTER TABLE instapay_releases ADD COLUMN reason_id INTEGER;
ALTER TABLE pricing_settings ADD COLUMN reason_id INTEGER;
ALTER TABLE workspace_pricing_overrides ADD COLUMN reason_id INTEGER;

-- billing_audit.reason was ALSO used as a structured key (an order id, a provider transaction id) for "once per ..." checks. That is not text; it gets its own column.
ALTER TABLE billing_audit ADD COLUMN ref TEXT;
CREATE INDEX billing_audit_action_ref ON billing_audit (action, ref) WHERE ref IS NOT NULL;
