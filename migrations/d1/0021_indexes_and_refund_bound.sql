-- W2-D1 (M-057, M-138).
-- Indexes on the workspace_id lookups the code issues that had none (they scanned the table).
CREATE INDEX IF NOT EXISTS phone_numbers_workspace ON phone_numbers (workspace_id, status);
CREATE INDEX IF NOT EXISTS refund_requests_workspace ON refund_requests (workspace_id, state, created_at);
CREATE INDEX IF NOT EXISTS billing_audit_workspace ON billing_audit (workspace_id, id);

-- A refund total can never exceed what was charged. Every writer clamps (MIN(amount_minor, ...)); these triggers are the backstop that turns any future writer's mistake
-- into a failed statement instead of a silently over-refunded order. (An existing row above its bound is not touched: a trigger checks only the rows it is asked to write.)
CREATE TRIGGER topups_refunded_bound_ins BEFORE INSERT ON topups WHEN NEW.refunded_minor > NEW.amount_minor BEGIN SELECT RAISE(ABORT, 'refunded exceeds charged'); END;
CREATE TRIGGER topups_refunded_bound_upd BEFORE UPDATE OF refunded_minor, amount_minor ON topups WHEN NEW.refunded_minor > NEW.amount_minor BEGIN SELECT RAISE(ABORT, 'refunded exceeds charged'); END;
CREATE TRIGGER package_orders_refunded_bound_ins BEFORE INSERT ON package_orders WHEN NEW.refunded_minor > NEW.amount_minor BEGIN SELECT RAISE(ABORT, 'refunded exceeds charged'); END;
CREATE TRIGGER package_orders_refunded_bound_upd BEFORE UPDATE OF refunded_minor, amount_minor ON package_orders WHEN NEW.refunded_minor > NEW.amount_minor BEGIN SELECT RAISE(ABORT, 'refunded exceeds charged'); END;
