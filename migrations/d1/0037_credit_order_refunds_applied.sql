-- WA-PACK-REFUND-1 follow-up (stacked on 0036): when a recorded refund's expiry was applied to the workspace. NULL = not yet; the daily repair job re-applies a refund of a PAID order that
-- still has NULL here (the expiry is idempotent under the refund's own ref, so re-applying never expires twice).
ALTER TABLE credit_order_refunds ADD COLUMN applied_at INTEGER;
CREATE INDEX credit_order_refunds_unapplied ON credit_order_refunds (refund_ref) WHERE applied_at IS NULL;
