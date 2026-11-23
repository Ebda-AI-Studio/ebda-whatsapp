-- AGENT-HEALTH-1 (CHAT-EVAL-BAR-1b flip sequence): platform-wide counters of AI turns per hour and per day, so two alerts can exist that the per-workspace Durable Objects cannot raise:
-- the reply guard refusing more than 3% of turns in an hour, and the AI cost per 1k turns passing 2 USD in a day. One row per (kind, slot): 'h' = epoch hour, 'd' = epoch day.
-- No workspace id, phone number or text: only counts, token sums and cost in micro-USD (USD per million tokens x tokens = micro-USD). Rows older than 8 days are pruned by the daily cron.
CREATE TABLE agent_health (
  kind TEXT NOT NULL,
  slot INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  paid_turns INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  alerted_blocked INTEGER NOT NULL DEFAULT 0,
  alerted_cost INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, slot)
) WITHOUT ROWID;
