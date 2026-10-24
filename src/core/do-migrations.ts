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
];

export function migrate(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = sql.exec<{ v: number | null }>('SELECT max(version) AS v FROM _migrations').one().v ?? 0;
  for (let v = done + 1; v <= DO_MIGRATIONS.length; v++) {
    sql.exec(DO_MIGRATIONS[v - 1]!);
    sql.exec('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', v, Date.now());
  }
}
