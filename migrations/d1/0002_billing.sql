-- Billing control plane (Phase 7). Money truth for one workspace lives in its Durable Object; D1 holds what is shared or looked up:
-- packages and subscriptions, which number is paid by whom, the effective-dated price inputs (immutable versions), and a mirror of
-- every ledger row so the two sides can be compared. No phone numbers, names or message content here.
CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_minor INTEGER NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  ai_credits INTEGER NOT NULL DEFAULT 0 CHECK (ai_credits >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- `version` only goes up; the workspace ignores an event that is not newer than its copy.
CREATE TABLE workspace_subscriptions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  package_id TEXT NOT NULL REFERENCES packages(id),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  cancelled_at INTEGER,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at INTEGER NOT NULL
);

-- Who pays Meta for a number: merchant_card = Meta bills the merchant (we only show the cost); platform_line = the wallet pays.
CREATE TABLE number_funding (
  phone_number_id TEXT PRIMARY KEY,
  funding TEXT NOT NULL CHECK (funding IN ('merchant_card', 'platform_line')),
  updated_at INTEGER NOT NULL
);

-- Immutable, effective-dated versions. A row is never updated or deleted; a change is a new version published ahead of its date.
CREATE TABLE rate_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ver INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  country TEXT NOT NULL,
  category TEXT NOT NULL,
  usd_micros INTEGER NOT NULL CHECK (usd_micros >= 0),
  published_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  UNIQUE (ver, country, category)
);
CREATE INDEX rate_cards_lookup ON rate_cards (country, category, effective_from);

CREATE TABLE fx_rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ver INTEGER NOT NULL UNIQUE,
  effective_from INTEGER NOT NULL,
  egp_per_usd_micros INTEGER NOT NULL CHECK (egp_per_usd_micros > 0),
  buffer_bps INTEGER NOT NULL DEFAULT 0 CHECK (buffer_bps >= 0),
  published_at INTEGER NOT NULL,
  actor TEXT NOT NULL
);

-- WA-MARGIN-1: margin, overdraft, FX buffer and VAT, edited only by a super admin; every change needs a reason and is audited.
CREATE TABLE pricing_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ver INTEGER NOT NULL UNIQUE,
  effective_from INTEGER NOT NULL,
  margin_bps INTEGER NOT NULL CHECK (margin_bps >= 0 AND margin_bps <= 100000),
  credit_limit_minor INTEGER NOT NULL CHECK (credit_limit_minor >= 0),
  fx_buffer_bps INTEGER NOT NULL DEFAULT 0 CHECK (fx_buffer_bps >= 0),
  vat_bps INTEGER NOT NULL DEFAULT 0 CHECK (vat_bps >= 0),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at)
  VALUES (1, 0, 0, 5000, 0, 0, 'system', 'WA-MARGIN-1 / WA-OVERDRAFT-1 launch defaults: 0% margin, 50 EGP overdraft, no VAT until Q5 is decided', 0);

CREATE TABLE workspace_pricing_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  ver INTEGER NOT NULL,
  effective_from INTEGER NOT NULL,
  margin_bps INTEGER NOT NULL CHECK (margin_bps >= 0 AND margin_bps <= 100000),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, ver)
);

-- Every ledger row of every workspace, copied from the Durable Object's outbox. Compared with the DO's own sums.
CREATE TABLE ledger_mirror (
  workspace_id TEXT NOT NULL,
  ledger TEXT NOT NULL CHECK (ledger IN ('wallet', 'credit')),
  ref TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, ledger, ref)
) WITHOUT ROWID;

-- Who changed what in billing, with the reason. Never updated or deleted.
CREATE TABLE billing_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  workspace_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT
);

CREATE TRIGGER rate_cards_no_update BEFORE UPDATE ON rate_cards BEGIN SELECT RAISE(ABORT, 'rate_cards are immutable'); END;
CREATE TRIGGER rate_cards_no_delete BEFORE DELETE ON rate_cards BEGIN SELECT RAISE(ABORT, 'rate_cards are immutable'); END;
CREATE TRIGGER fx_rates_no_update BEFORE UPDATE ON fx_rates BEGIN SELECT RAISE(ABORT, 'fx_rates are immutable'); END;
CREATE TRIGGER fx_rates_no_delete BEFORE DELETE ON fx_rates BEGIN SELECT RAISE(ABORT, 'fx_rates are immutable'); END;
CREATE TRIGGER pricing_settings_no_update BEFORE UPDATE ON pricing_settings BEGIN SELECT RAISE(ABORT, 'pricing_settings are immutable'); END;
CREATE TRIGGER pricing_settings_no_delete BEFORE DELETE ON pricing_settings BEGIN SELECT RAISE(ABORT, 'pricing_settings are immutable'); END;
CREATE TRIGGER pricing_overrides_no_update BEFORE UPDATE ON workspace_pricing_overrides BEGIN SELECT RAISE(ABORT, 'overrides are immutable'); END;
CREATE TRIGGER pricing_overrides_no_delete BEFORE DELETE ON workspace_pricing_overrides BEGIN SELECT RAISE(ABORT, 'overrides are immutable'); END;
CREATE TRIGGER billing_audit_no_update BEFORE UPDATE ON billing_audit BEGIN SELECT RAISE(ABORT, 'billing_audit is append-only'); END;
CREATE TRIGGER billing_audit_no_delete BEFORE DELETE ON billing_audit BEGIN SELECT RAISE(ABORT, 'billing_audit is append-only'); END;
CREATE TRIGGER ledger_mirror_no_update BEFORE UPDATE ON ledger_mirror BEGIN SELECT RAISE(ABORT, 'ledger_mirror is append-only'); END;
CREATE TRIGGER ledger_mirror_no_delete BEFORE DELETE ON ledger_mirror BEGIN SELECT RAISE(ABORT, 'ledger_mirror is append-only'); END;
