-- WA-GRACE-1: when a subscription FIRST became past_due (epoch ms). The grace for service messages ends at the period end and, in any case,
-- 7 days after this moment. Set by the one writer (setSubscription) when the status turns past_due, kept while it stays past_due, cleared otherwise.
ALTER TABLE workspace_subscriptions ADD COLUMN past_due_since INTEGER;
