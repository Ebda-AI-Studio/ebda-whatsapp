-- WA-SHARED-FREE-1. On the shared number a service reply is charged at the normal rate all month (a predictable price). At month close
-- every workspace reports what it was charged (shared_number_usage); the operator enters what Meta actually billed for the number and
-- publishes ONE immutable true-up per (month, number); each workspace then rebates its pro-rata share of the difference.
CREATE TABLE shared_number_usage (
  month TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  charged_minor INTEGER NOT NULL CHECK (charged_minor >= 0),
  service_count INTEGER NOT NULL CHECK (service_count >= 0),
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (month, phone_number_id, workspace_id)
) WITHOUT ROWID;

CREATE TABLE shared_trueups (
  month TEXT NOT NULL,
  phone_number_id TEXT NOT NULL,
  actual_minor INTEGER NOT NULL CHECK (actual_minor >= 0),
  total_charged_minor INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  rebate_minor INTEGER NOT NULL CHECK (rebate_minor >= 0),
  actor TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (month, phone_number_id)
) WITHOUT ROWID;
CREATE TRIGGER shared_trueups_no_update BEFORE UPDATE ON shared_trueups BEGIN SELECT RAISE(ABORT, 'shared_trueups are immutable'); END;
CREATE TRIGGER shared_trueups_no_delete BEFORE DELETE ON shared_trueups BEGIN SELECT RAISE(ABORT, 'shared_trueups are immutable'); END;
