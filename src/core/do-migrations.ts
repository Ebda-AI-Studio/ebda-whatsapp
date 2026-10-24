/** WorkspaceDO SQLite schema, applied in order and recorded in _migrations. Never edit a shipped entry; append. */
export const DO_MIGRATIONS: readonly string[] = [
  `CREATE TABLE contacts (
     id INTEGER PRIMARY KEY,
     wa_id TEXT UNIQUE NOT NULL,
     profile_name TEXT,
     last_inbound_at INTEGER
   );
   CREATE TABLE conversations (
     id INTEGER PRIMARY KEY,
     contact_id INTEGER UNIQUE NOT NULL REFERENCES contacts(id),
     last_message_at INTEGER,
     unread INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE messages (
     id INTEGER PRIMARY KEY,
     wamid TEXT UNIQUE,
     conversation_id INTEGER NOT NULL REFERENCES conversations(id),
     direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
     type TEXT NOT NULL,
     preview TEXT,
     body_r2_key TEXT,
     status TEXT,
     status_rank INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT UNIQUE,
     error_code INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX messages_conversation ON messages (conversation_id, created_at);
   CREATE TABLE message_status_events (
     id INTEGER PRIMARY KEY,
     wamid TEXT NOT NULL,
     status TEXT NOT NULL,
     ts INTEGER NOT NULL,
     applied INTEGER NOT NULL,
     error_code INTEGER
   );
   CREATE INDEX status_events_wamid ON message_status_events (wamid);`,
  `ALTER TABLE messages ADD COLUMN claim_attempts INTEGER NOT NULL DEFAULT 0;`,
  // v3: full text for bodies up to 1 KB (larger ones live in R2); one row per distinct status event.
  `ALTER TABLE messages ADD COLUMN body TEXT;
   CREATE UNIQUE INDEX status_events_unique ON message_status_events (wamid, status, ts);`,
  // v4: R2 objects owed a delete (erasure); rows leave only after R2 confirms.
  `CREATE TABLE r2_pending_deletes (key TEXT PRIMARY KEY);`,
  // v5 (Phase 2, send API): what an outbound message carries, consent state, approved templates, files staged for sending.
  `ALTER TABLE messages ADD COLUMN template_name TEXT;
   ALTER TABLE messages ADD COLUMN template_lang TEXT;
   ALTER TABLE messages ADD COLUMN media_mime TEXT;
   ALTER TABLE messages ADD COLUMN media_size INTEGER;
   ALTER TABLE messages ADD COLUMN media_r2_key TEXT;
   ALTER TABLE contacts ADD COLUMN opted_out_at INTEGER;
   ALTER TABLE contacts ADD COLUMN consent_source TEXT;
   ALTER TABLE contacts ADD COLUMN consent_at INTEGER;
   CREATE TABLE templates (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     language TEXT NOT NULL,
     category TEXT NOT NULL,
     status TEXT NOT NULL,
     components TEXT NOT NULL,
     rejected_reason TEXT,
     updated_at INTEGER NOT NULL,
     UNIQUE (name, language)
   );
   CREATE TABLE uploads (
     id TEXT PRIMARY KEY,
     meta_media_id TEXT NOT NULL,
     mime TEXT NOT NULL,
     size INTEGER NOT NULL,
     filename TEXT,
     r2_key TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // v6 (Phase 2, scheduler): every deferred piece of work, so the single DO alarm can serve backup, R2 drain, throttled sends and more.
  `CREATE TABLE scheduled_tasks (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     due_at INTEGER NOT NULL,
     payload TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   );
   CREATE INDEX scheduled_tasks_due ON scheduled_tasks (due_at);`,
  // v7 (Phase 2, Meta limits): per-number tier / throughput settings and the unique business-initiated recipients of the rolling 24 h.
  `CREATE TABLE number_limits (
     phone_number_id TEXT PRIMARY KEY,
     tier INTEGER NOT NULL,
     mps INTEGER NOT NULL,
     tokens REAL NOT NULL,
     tokens_at INTEGER NOT NULL,
     alerted_at INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE tier_slots (
     phone_number_id TEXT NOT NULL,
     contact_id INTEGER NOT NULL,
     started_at INTEGER NOT NULL,
     PRIMARY KEY (phone_number_id, contact_id)
   ) WITHOUT ROWID;
   CREATE INDEX tier_slots_started ON tier_slots (phone_number_id, started_at);`,
];

export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = sql.exec<{ v: number | null }>('SELECT max(version) AS v FROM _migrations').one().v ?? 0;
    for (let v = done + 1; v <= DO_MIGRATIONS.length; v++) {
      sql.exec(DO_MIGRATIONS[v - 1]!);
      sql.exec('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', v, Date.now());
    }
  });
}
