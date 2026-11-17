-- Daily FX (WA-FX-DAILY-1): the cron appends one fx_rates row per UTC day. Audit columns record where the rate came from and the inputs of the
-- computed buffer; they are nullable because the operator's hand-published rows (and every row before this migration) carry none. fx_rates stays
-- immutable (its triggers are untouched); ADD COLUMN does not fire them.
ALTER TABLE fx_rates ADD COLUMN source TEXT;
ALTER TABLE fx_rates ADD COLUMN obs_day TEXT;
ALTER TABLE fx_rates ADD COLUMN vol_bps REAL;
ALTER TABLE fx_rates ADD COLUMN drift_pct REAL;
ALTER TABLE fx_rates ADD COLUMN buffer_mode TEXT;
-- One row per UTC day, guaranteed by the database: two cron runs (or a retry) cannot both insert.
CREATE UNIQUE INDEX fx_rates_obs_day ON fx_rates (obs_day) WHERE obs_day IS NOT NULL;

-- Operator pin of the FX buffer. Append-only versions; the newest row wins; buffer_bps NULL means "unpinned, use the computed buffer".
CREATE TABLE fx_buffer_pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buffer_bps INTEGER CHECK (buffer_bps IS NULL OR (buffer_bps >= 0 AND buffer_bps <= 10000)),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER fx_buffer_pins_no_update BEFORE UPDATE ON fx_buffer_pins BEGIN SELECT RAISE(ABORT, 'fx_buffer_pins are immutable'); END;
CREATE TRIGGER fx_buffer_pins_no_delete BEFORE DELETE ON fx_buffer_pins BEGIN SELECT RAISE(ABORT, 'fx_buffer_pins are immutable'); END;
