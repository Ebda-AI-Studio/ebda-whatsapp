/** WorkspaceDO SQLite schema, applied in order and recorded in _migrations. Never edit a shipped entry; append. */
export const DO_MIGRATIONS: readonly string[] = [
  // v1 (Phase 1, inbox core): contacts, conversations, messages and their status events.
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
  // v2: how many times a send job was claimed (a stuck claim is retried at most once).
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
  // v8 (Phase 2, inbox): assignment, notes, tags, list/sort indexes and full-text search over message previews.
  `ALTER TABLE conversations ADD COLUMN assignee_user_id TEXT;
   CREATE TABLE notes (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL,
     author_user_id TEXT NOT NULL,
     text TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX notes_conversation ON notes (conversation_id, id);
   CREATE TABLE conversation_tags (
     conversation_id INTEGER NOT NULL,
     tag TEXT NOT NULL,
     PRIMARY KEY (conversation_id, tag)
   ) WITHOUT ROWID;
   CREATE INDEX conversations_recent ON conversations (last_message_at DESC, id DESC);
   CREATE INDEX conversations_unread ON conversations (last_message_at DESC, id DESC) WHERE unread > 0;
   CREATE INDEX conversations_unassigned ON conversations (last_message_at DESC, id DESC) WHERE assignee_user_id IS NULL;
   CREATE INDEX conversations_assignee ON conversations (assignee_user_id, last_message_at DESC, id DESC);
   CREATE INDEX messages_conversation_id ON messages (conversation_id, id);
   CREATE VIRTUAL TABLE messages_fts USING fts5(text);`,
  // v9 (Phase 2, realtime): the last events, so a client that missed some can resync by seq. AUTOINCREMENT keeps seq monotonic after trims.
  `CREATE TABLE events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     payload TEXT NOT NULL
   );`,
  // v10 (Phase 2, erasure follow-up): idempotency keys of erased messages, so a send job still in the queue is dropped instead of re-creating the contact.
  `CREATE TABLE erased_keys (key TEXT PRIMARY KEY);`,
  // v11 (lease): a task being run is claimed until lease_until, so overlapping runners (alarm + direct calls) never run it twice.
  `ALTER TABLE scheduled_tasks ADD COLUMN lease_until INTEGER;`,
  // v12 (final review): why a message failed when Meta never saw it (error_code is Meta's numbers only), e.g. 'opted_out'.
  `ALTER TABLE messages ADD COLUMN error_reason TEXT;`,
  // v13 (Phase 4, Store link): events already applied, newest version seen per entity (a late older event is dropped),
  // workspace settings, the customer key on contacts, the orders this workspace knows about (COD state, outcome, payment proof)
  // and the catalog changes waiting to be pushed to Meta.
  `CREATE TABLE processed_events (event_id TEXT PRIMARY KEY, type TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX processed_events_at ON processed_events (at);
   CREATE TABLE entity_versions (entity TEXT PRIMARY KEY, version INTEGER NOT NULL);
   CREATE TABLE store_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   ALTER TABLE contacts ADD COLUMN buyer_key TEXT;
   CREATE INDEX contacts_buyer_key ON contacts (buyer_key) WHERE buyer_key IS NOT NULL;
   CREATE TABLE store_orders (
     order_id TEXT PRIMARY KEY,
     order_number TEXT,
     wa_id TEXT,
     buyer_key TEXT,
     payment_method TEXT,
     status TEXT,
     total_minor INTEGER,
     currency TEXT,
     cod_state TEXT,
     cod_requested_at INTEGER,
     outcome TEXT,
     outcome_at INTEGER,
     outcome_idem TEXT,
     outcome_pushed_at INTEGER,
     proof_wamid TEXT,
     proof_at INTEGER,
     proof_deadline_at INTEGER,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX store_orders_wa ON store_orders (wa_id);
   CREATE INDEX store_orders_number ON store_orders (order_number);
   CREATE TABLE catalog_dirty (product_id TEXT PRIMARY KEY, variant_ids TEXT NOT NULL, deleted INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  // v14 (Phase 4, orders): the customer's language per order, so a reply or a payment notice speaks it.
  `ALTER TABLE store_orders ADD COLUMN locale TEXT;`,
  // v15 (Phase 4, ordering in chat): where each customer is in the ordering conversation. Transient; not backed up.
  `CREATE TABLE bot_sessions (wa_id TEXT PRIMARY KEY, state TEXT NOT NULL, locale TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  // v16 (Phase 4, erasure race): an order the Store created for a customer who was erased while the order call was in flight.
  // Only the order id and the hashed customer key stay, until the Store has been told (so it can erase or cancel it); then the row is deleted. Not backed up.
  `CREATE TABLE store_orders_after_erase (order_id TEXT PRIMARY KEY, buyer_key TEXT NOT NULL, created_at INTEGER NOT NULL, pushed_at INTEGER);`,
  // v17 (Phase 5, AI agent): the agent's settings and counters (key/value; the merchant's own model key is stored encrypted).
  `CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v18 (Phase 5, agent turns): who wrote each outgoing message; the agent's finished turns (a replayed task does not call the model
  // again); and the conversations handed to a person (the bot stays silent until `until_at`).
  `ALTER TABLE messages ADD COLUMN author TEXT;
   CREATE TABLE agent_turns (message_id INTEGER PRIMARY KEY, outcome TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE agent_handoffs (wa_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, until_at INTEGER NOT NULL, reason TEXT NOT NULL);`,
  // v19 (Phase 5, AI credits; the Phase 7 money design): an append-only ledger (unique ref per row, no update or delete) and the
  // holds that reserve a credit before the model is called. Rows carry no phone number or name; money rows are never deleted.
  `CREATE TABLE credit_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('grant', 'purchase', 'ai_charge', 'expire', 'refund', 'adjustment')),
     amount INTEGER NOT NULL CHECK (amount <> 0),
     balance_after INTEGER NOT NULL,
     ref TEXT NOT NULL UNIQUE,
     parent_ref TEXT,
     actor TEXT,
     note TEXT
   );
   CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
   CREATE TRIGGER credit_ledger_no_delete BEFORE DELETE ON credit_ledger BEGIN SELECT RAISE(ABORT, 'credit_ledger is append-only'); END;
   CREATE TABLE credit_holds (
     ref TEXT PRIMARY KEY,
     amount INTEGER NOT NULL CHECK (amount > 0),
     state TEXT NOT NULL CHECK (state IN ('held', 'charged', 'released', 'expired')),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     settled_at INTEGER
   );
   CREATE TRIGGER credit_holds_no_delete BEFORE DELETE ON credit_holds BEGIN SELECT RAISE(ABORT, 'credit holds are never deleted'); END;`,
  // v20 (Phase 5, knowledge base): the merchant's FAQ text in chunks (a new version per change; the old one is dropped once the new
  // one is searchable), and which catalog variants are in the vector index (hash of the text that was embedded). Derived data; not backed up.
  `CREATE TABLE kb_chunks (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, idx INTEGER NOT NULL, vec_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX kb_chunks_version ON kb_chunks (version, indexed);
   CREATE TABLE catalog_vectors (retailer_id TEXT PRIMARY KEY, vec_id TEXT NOT NULL, hash TEXT NOT NULL);`,
  // v21 (Phase 6.1, contacts + import): contact tags (the inbox keeps its own per-conversation tags; segments read both), one row per
  // CSV import with its progress, and the rejected rows (line + reason only: a rejected row's phone is never stored). last_import_id
  // marks the import that last touched a contact, which is how a number repeated inside one file is told from one that already existed.
  `ALTER TABLE contacts ADD COLUMN last_import_id TEXT;
   CREATE TABLE contact_tags (contact_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (contact_id, tag)) WITHOUT ROWID;
   CREATE INDEX contact_tags_tag ON contact_tags (tag, contact_id);
   CREATE TABLE imports (
     id TEXT PRIMARY KEY,
     filename TEXT NOT NULL,
     r2_key TEXT NOT NULL,
     size INTEGER NOT NULL,
     consented INTEGER NOT NULL,
     mapping TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
     next_offset INTEGER NOT NULL DEFAULT 0,
     next_line INTEGER NOT NULL DEFAULT 1,
     delimiter INTEGER,
     cols TEXT,
     total INTEGER NOT NULL DEFAULT 0,
     created_count INTEGER NOT NULL DEFAULT 0,
     updated_count INTEGER NOT NULL DEFAULT 0,
     rejected_count INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     finished_at INTEGER
   );
   CREATE TABLE import_rejects (import_id TEXT NOT NULL, line INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (import_id, line)) WITHOUT ROWID;`,
  // v22 (Phase 6.2, segments): saved audience filters. Criteria are JSON validated by the API; the audience query always adds
  // "not opted out" and "consent on record", whatever the criteria say.
  `CREATE TABLE segments (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     criteria TEXT NOT NULL,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX segments_name ON segments (name);`,
  // v23 (Phase 6.3, broadcasts): a campaign, the pages of its audience already queued (one row per page, the unit a Workflow step
  // repeats safely), and one row per recipient. A recipient's message is found by its stable idempotency key camp:<campaign>:<contact>,
  // so per-status counts are read from the messages themselves and cannot drift. The partial index keeps "how many sends are still
  // waiting" cheap. Erasing a contact deletes its recipient rows.
  `CREATE TABLE campaigns (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     template_name TEXT NOT NULL,
     template_language TEXT NOT NULL,
     category TEXT NOT NULL,
     params TEXT NOT NULL,
     criteria TEXT NOT NULL,
     segment_id INTEGER,
     phone_number_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
     pause_reason TEXT,
     scheduled_at INTEGER,
     daily_send_limit INTEGER,
     attempt INTEGER NOT NULL DEFAULT 0,
     next_page INTEGER NOT NULL DEFAULT 0,
     cursor INTEGER NOT NULL DEFAULT 0,
     created_by TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER
   );
   CREATE INDEX campaigns_status ON campaigns (status);
   CREATE TABLE campaign_pages (
     campaign_id TEXT NOT NULL,
     page INTEGER NOT NULL,
     from_id INTEGER NOT NULL,
     to_id INTEGER NOT NULL,
     count INTEGER NOT NULL,
     done INTEGER NOT NULL,
     reserve_ref TEXT NOT NULL,
     reserved_minor INTEGER NOT NULL,
     settled INTEGER NOT NULL DEFAULT 0,
     at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, page)
   ) WITHOUT ROWID;
   CREATE TABLE campaign_recipients (
     campaign_id TEXT NOT NULL,
     contact_id INTEGER NOT NULL,
     page INTEGER NOT NULL,
     idem TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued', 'skipped')),
     skip_reason TEXT,
     at INTEGER NOT NULL,
     PRIMARY KEY (campaign_id, contact_id)
   ) WITHOUT ROWID;
   CREATE INDEX campaign_recipients_idem ON campaign_recipients (idem);
   CREATE INDEX campaign_recipients_at ON campaign_recipients (campaign_id, at);
   CREATE INDEX campaign_recipients_contact ON campaign_recipients (contact_id);
   CREATE INDEX messages_pending ON messages (idempotency_key) WHERE status IN ('queued', 'claimed', 'retry') AND direction = 'out';`,
  // v24 (Phase 6.4, link tracking): the merchant's destination per campaign, and one short link per recipient. The code is the key
  // (128 random bits, see campaigns/links.ts); a click bumps the counters. Erasing a contact deletes its links, so they stop working.
  `ALTER TABLE campaigns ADD COLUMN link_url TEXT;
   CREATE TABLE campaign_links (
     code TEXT PRIMARY KEY,
     campaign_id TEXT NOT NULL,
     contact_id INTEGER NOT NULL,
     clicks INTEGER NOT NULL DEFAULT 0,
     first_click_at INTEGER,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID;
   CREATE UNIQUE INDEX campaign_links_recipient ON campaign_links (campaign_id, contact_id);
   CREATE INDEX campaign_links_contact ON campaign_links (contact_id);`,
  // v25 (Phase 7.1, packages): the workspace's copy of its subscription. `version` only moves forward; see billing/entitlements.ts.
  `CREATE TABLE entitlements (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     version INTEGER NOT NULL,
     package_id TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
     period_start INTEGER NOT NULL,
     period_end INTEGER NOT NULL,
     ai_credits INTEGER NOT NULL DEFAULT 0,
     cancelled_at INTEGER,
     updated_at INTEGER NOT NULL
   );`,
  // v26 (Phase 7.2, money). Authoritative for one workspace; see billing/engine.ts for the invariants.
  // wallet_ledger: append-only (triggers), one row per money movement, balance_after written in the same transaction as the row.
  // Amounts are signed integer piasters; amount_minor = net_minor + vat_minor. No phone number, name or message text is ever stored here.
  // wallet_holds: reservations (never deleted); a hold is 'held' until the message settles it. billable_sends: one row per Meta message
  // id, kept for as long as the money rows are (erasing a contact does not touch it). ledger_outbox: rows waiting to be copied to D1.
  `CREATE TABLE wallet_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('topup', 'meta_charge', 'meta_adjust', 'ai_charge', 'refund', 'chargeback', 'adjustment', 'grant', 'expire')),
     net_minor INTEGER NOT NULL,
     vat_minor INTEGER NOT NULL DEFAULT 0,
     amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0 AND amount_minor = net_minor + vat_minor),
     balance_after INTEGER NOT NULL,
     ref TEXT NOT NULL UNIQUE,
     wamid TEXT,
     category TEXT,
     usd_micros INTEGER,
     rate_ver INTEGER,
     fx_ver INTEGER,
     pricing_ver INTEGER,
     actor TEXT,
     note TEXT
   );
   CREATE INDEX wallet_ledger_at ON wallet_ledger (at);
   CREATE TRIGGER wallet_ledger_no_update BEFORE UPDATE ON wallet_ledger BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;
   CREATE TRIGGER wallet_ledger_no_delete BEFORE DELETE ON wallet_ledger BEGIN SELECT RAISE(ABORT, 'wallet_ledger is append-only'); END;
   CREATE TABLE wallet_holds (
     ref TEXT PRIMARY KEY,
     parent_ref TEXT,
     amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
     category_est TEXT,
     state TEXT NOT NULL CHECK (state IN ('held', 'charged', 'released', 'expired')),
     wait_until INTEGER,
     expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     settled_at INTEGER,
     number_id TEXT,
     country TEXT,
     funding TEXT,
     release_reason TEXT,
     closing INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX wallet_holds_state ON wallet_holds (state, expires_at);
   CREATE INDEX wallet_holds_parent ON wallet_holds (parent_ref) WHERE parent_ref IS NOT NULL;
   CREATE TRIGGER wallet_holds_no_delete BEFORE DELETE ON wallet_holds BEGIN SELECT RAISE(ABORT, 'wallet holds are never deleted'); END;
   CREATE TABLE billable_sends (
     wamid TEXT PRIMARY KEY,
     hold_ref TEXT,
     number_id TEXT,
     country TEXT,
     category_est TEXT,
     category_meta TEXT,
     type TEXT,
     pricing_model TEXT,
     billable INTEGER,
     funding TEXT NOT NULL,
     delivered_at INTEGER,
     charged_ref TEXT,
     charged_category TEXT,
     charged_minor INTEGER,
     unpriced INTEGER NOT NULL DEFAULT 0,
     cost_usd_micros INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX billable_sends_month ON billable_sends (delivered_at);
   CREATE TRIGGER billable_sends_no_delete BEFORE DELETE ON billable_sends BEGIN SELECT RAISE(ABORT, 'billable_sends are never deleted'); END;
   CREATE TABLE ledger_outbox (
     ledger TEXT NOT NULL CHECK (ledger IN ('wallet', 'credit')),
     ref TEXT NOT NULL,
     row_json TEXT NOT NULL,
     drained_at INTEGER,
     PRIMARY KEY (ledger, ref)
   ) WITHOUT ROWID;
   CREATE INDEX ledger_outbox_pending ON ledger_outbox (ledger, ref) WHERE drained_at IS NULL;
   INSERT INTO ledger_outbox (ledger, ref, row_json) SELECT 'credit', ref, json_object('at', at, 'kind', kind, 'amount', amount, 'balance_after', balance_after) FROM credit_ledger;
   CREATE TABLE wallet_waits (key TEXT PRIMARY KEY, wait_until INTEGER NOT NULL, created_at INTEGER NOT NULL);
   ALTER TABLE message_status_events ADD COLUMN pricing_json TEXT;`,
  // v27 (Phase 7.2/7.3, price inputs): this workspace's copy of the D1 control-plane versions. Immutable once copied (src_id is the D1 row id,
  // so the pull is incremental); funding is replaced as a whole. Staleness class BOUNDED: at most PRICING_MAX_AGE_MS old, and every
  // effective-dated change is published far enough ahead that the copy has it before it takes effect (see billing/pricing.ts).
  `CREATE TABLE pricing_rates (src_id INTEGER PRIMARY KEY, ver INTEGER NOT NULL, effective_from INTEGER NOT NULL, country TEXT NOT NULL, category TEXT NOT NULL, usd_micros INTEGER NOT NULL);
   CREATE INDEX pricing_rates_lookup ON pricing_rates (country, category, effective_from);
   CREATE TABLE pricing_fx (src_id INTEGER PRIMARY KEY, ver INTEGER NOT NULL, effective_from INTEGER NOT NULL, egp_per_usd_micros INTEGER NOT NULL, buffer_bps INTEGER NOT NULL);
   CREATE TABLE pricing_settings (src_id INTEGER PRIMARY KEY, ver INTEGER NOT NULL, effective_from INTEGER NOT NULL, margin_bps INTEGER NOT NULL, credit_limit_minor INTEGER NOT NULL, fx_buffer_bps INTEGER NOT NULL, vat_bps INTEGER NOT NULL);
   CREATE TABLE pricing_overrides (src_id INTEGER PRIMARY KEY, ver INTEGER NOT NULL, effective_from INTEGER NOT NULL, margin_bps INTEGER NOT NULL);
   CREATE TABLE number_funding (phone_number_id TEXT PRIMARY KEY, funding TEXT NOT NULL CHECK (funding IN ('merchant_card', 'platform_line')));`,
  // v28 (fail-closed money): a billable delivery whose rate cannot be found is kept as pending_rate and charged when the rate appears.
  `ALTER TABLE billable_sends ADD COLUMN pending_rate INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX billable_sends_pending ON billable_sends (wamid) WHERE pending_rate = 1;`,
  // v29 (Phase 9.3, connectors): the agent's tools into a client's own systems. `secret_enc` is AES-GCM (workspace id as AD), never returned by any API.
  `CREATE TABLE connectors (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('webhook', 'odoo')),
     enabled INTEGER NOT NULL DEFAULT 0,
     config_json TEXT NOT NULL,
     secret_enc TEXT,
     updated_at INTEGER NOT NULL,
     updated_by TEXT
   ) WITHOUT ROWID;`,
  // v30 (bot analytics funnel): NO personal data. A marker is (Cairo day, step, per-day salted token); the token is HMAC(day's random salt, wa id)
  // and cannot be joined across days. Salt and markers of a day are deleted when that day is rolled up into counts (bot_funnel_daily).
  `CREATE TABLE bot_funnel_salt (day TEXT PRIMARY KEY, salt TEXT NOT NULL) WITHOUT ROWID;
   CREATE TABLE bot_funnel_markers (day TEXT NOT NULL, step TEXT NOT NULL, token TEXT NOT NULL, PRIMARY KEY (day, step, token)) WITHOUT ROWID;
   CREATE TABLE bot_funnel_daily (day TEXT NOT NULL, step TEXT NOT NULL, customers INTEGER NOT NULL, PRIMARY KEY (day, step)) WITHOUT ROWID;`,
  // v31 (search as you type): contact names, normalised with normaliseText, rowid = contacts.id. Filled by the DO (reindexContactsIfEmpty) because
  // normalisation is JS; kept current by indexContactName on every write of contacts.profile_name and by the contact erasure.
  `CREATE VIRTUAL TABLE contacts_fts USING fts5(name);`,
  // v32 (WA-PRICE-1, package limits): the limits the entitlement event carries, kept in the workspace's own copy. The defaults are the DENY shape
  // (1 member, no feature), so a row written before this migration grants nothing until the next event or the daily reconcile re-sends it.
  `ALTER TABLE entitlements ADD COLUMN max_members INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE entitlements ADD COLUMN lim_campaigns INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE entitlements ADD COLUMN lim_order_in_chat INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE entitlements ADD COLUMN lim_api INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE entitlements ADD COLUMN lim_priority_support INTEGER NOT NULL DEFAULT 0;`,
  // v33 (WA-GRACE-1): when the control plane saw the subscription first fail to renew. NULL = never past_due (or unknown: serviceAllowed then bounds the grace from updated_at).
  `ALTER TABLE entitlements ADD COLUMN past_due_since INTEGER;`,
  // v34 (W2-META number health): the state of each number is its latest log row (no row = green); the log is the audit of every change.
  // number_health_signal keeps when (Meta's own time, ms) the newest signal applied to a number happened, so an older one retried later is dropped.
  // number_health_events counts the Meta errors that signal a sender-quality problem (131049 frequency cap, 131026 undeliverable) per number in
  // 10-minute buckets, for the spike guard. No phone number, no message content.
  `CREATE TABLE number_health_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     phone_number_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     from_state TEXT NOT NULL,
     to_state TEXT NOT NULL CHECK (to_state IN ('green', 'yellow', 'red', 'restricted')),
     source TEXT NOT NULL,
     detail TEXT
   );
   CREATE INDEX number_health_log_number ON number_health_log (phone_number_id, id);
   CREATE TABLE number_health_signal (
     phone_number_id TEXT PRIMARY KEY,
     signal_at INTEGER NOT NULL
   );
   CREATE TABLE number_health_events (
     phone_number_id TEXT NOT NULL,
     bucket INTEGER NOT NULL,
     n INTEGER NOT NULL,
     PRIMARY KEY (phone_number_id, bucket)
   );`,
  // v35 (P2 yearly): the billing period length (1 or 12 months) of the workspace's package, carried by the entitlement event. A period longer than a month
  // gets its AI credits one month at a time (credit_month tasks), never 12x at once.
  `ALTER TABLE entitlements ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1;`,
  // v36 (W2-RETENTION): the retention purge finds old messages by time, and a merchant-edited contact name must not be overwritten by WhatsApp's profile name.
  `CREATE INDEX messages_created ON messages (created_at);
   ALTER TABLE contacts ADD COLUMN name_edited INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE events ADD COLUMN at INTEGER;`, // events.at: the realtime log is purged by age too
  // v37 (W2 review): "is this R2 key still referenced by a message?" (retention purge, erasure of one contact) probes these two partial indexes instead of scanning every message per key.
  `CREATE INDEX messages_body_r2 ON messages (body_r2_key) WHERE body_r2_key IS NOT NULL;
   CREATE INDEX messages_media_r2 ON messages (media_r2_key) WHERE media_r2_key IS NOT NULL;`,
  // v38 (W2-CONSENT, A4): the evidence behind a consent: who attested, the exact wording shown, when and through which door (import / opt_in / link).
  // Append-only, erased with the contact. imports.consent_wording keeps the wording the owner's screen showed when the import started.
  `CREATE TABLE consent_proofs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     contact_id INTEGER NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('import', 'opt_in', 'link')),
     attested_by TEXT NOT NULL,
     wording TEXT NOT NULL,
     at INTEGER NOT NULL,
     ref TEXT
   );
   CREATE INDEX consent_proofs_contact ON consent_proofs (contact_id, id);
   ALTER TABLE imports ADD COLUMN consent_wording TEXT;`,
  // v39 (P1b, WA-SEATS-1): which staff the owner seated. Membership lives in the Store; this is only the owner's choice, bounded by the package's member limit.
  `CREATE TABLE seats (
     user_id TEXT PRIMARY KEY,
     assigned_at INTEGER NOT NULL,
     assigned_by TEXT NOT NULL
   );`,
  // v40 (voice notes): the once-marker and the inbox state of a transcribed voice note. 'ok' = the transcript is the message's body; 'failed' = never transcribed (the inbox says so).
  `ALTER TABLE messages ADD COLUMN voice_state TEXT CHECK (voice_state IN ('ok', 'failed'));`,
  // v41 (WhatsApp catalogue): what this workspace has put into the Meta catalogue, one row per retailer id. It lets a deleted product or a removed variant be archived
  // (the Store sends no ids for a deleted product), keeps the pass a full reconcile is on, and is the merchant's list of items left out and why. Rebuilt by every pass; not backed up.
  `CREATE TABLE catalog_items (
     retailer_id TEXT PRIMARY KEY,
     product_id TEXT NOT NULL,
     group_id TEXT,
     status TEXT NOT NULL CHECK (status IN ('synced', 'excluded', 'rejected')),
     reason TEXT,
     pass INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX catalog_items_product ON catalog_items (product_id);
   CREATE INDEX catalog_items_status ON catalog_items (status);`,
  // v42 (merchant template self-service): Meta's template id (an edit and a one-language delete need it), the merchant's own title, when we submitted it, and the edit log
  // Meta's edit limits are counted from (APPROVED: 1 per 24 h, 10 per 30 days). All additive.
  `ALTER TABLE templates ADD COLUMN meta_id TEXT;
   ALTER TABLE templates ADD COLUMN label TEXT;
   ALTER TABLE templates ADD COLUMN submitted_at INTEGER;
   CREATE TABLE template_edits (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     language TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX template_edits_lookup ON template_edits (name, language, at);`,
  // v43 (Smart Layer assistant, SL-CHAT-1): the assistant's journal. Masked text only (secrets and phones are masked before anything is written), 90-day retention,
  // gone with the workspace. Previews/applied/approvals are used from the preview and confirm phases; the status columns are the single-winner compare-and-set.
  `CREATE TABLE sl_turns (
     seq INTEGER PRIMARY KEY,
     id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     role TEXT NOT NULL,
     masked_text TEXT NOT NULL,
     at INTEGER NOT NULL,
     release_id TEXT NOT NULL
   );
   CREATE INDEX sl_turns_conv ON sl_turns (store_id, thread_id, seq);
   CREATE INDEX sl_turns_at ON sl_turns (at);
   CREATE TABLE sl_audit (
     seq INTEGER PRIMARY KEY,
     id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     json TEXT NOT NULL
   );
   CREATE INDEX sl_audit_store_at ON sl_audit (store_id, at);
   CREATE TABLE sl_previews (
     id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     json TEXT NOT NULL,
     PRIMARY KEY (store_id, id)
   );
   CREATE INDEX sl_previews_at ON sl_previews (created_at);
   CREATE TABLE sl_applied (
     id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     applied_at INTEGER NOT NULL,
     undone_at INTEGER,
     json TEXT NOT NULL,
     PRIMARY KEY (store_id, id)
   );
   CREATE INDEX sl_applied_at ON sl_applied (applied_at);
   CREATE TABLE sl_approvals (
     id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     user_id TEXT NOT NULL,
     preview_id TEXT NOT NULL,
     token_hash TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (store_id, id)
   );
   CREATE INDEX sl_approvals_at ON sl_approvals (created_at);
   CREATE TABLE sl_decisions (
     seq INTEGER PRIMARY KEY,
     approval_id TEXT NOT NULL,
     store_id TEXT NOT NULL,
     decider TEXT NOT NULL,
     decision TEXT NOT NULL,
     reason TEXT,
     at INTEGER NOT NULL
   );
   CREATE INDEX sl_decisions_approval ON sl_decisions (store_id, approval_id);
   CREATE INDEX sl_decisions_at ON sl_decisions (at);
   CREATE TABLE sl_counters (
     seq INTEGER PRIMARY KEY,
     key TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX sl_counters_key ON sl_counters (key, at);`,
  // v44 (Smart Layer template writer): a generated draft is kept for an hour under a key made from the workspace, the person and the request, so the preview the merchant
  // sees and the re-preview that runs when they press confirm are the SAME draft (a second model call would write different words and the press would never match).
  `CREATE TABLE sl_cache (
     key TEXT PRIMARY KEY,
     store_id TEXT NOT NULL,
     json TEXT NOT NULL,
     at INTEGER NOT NULL
   );
   CREATE INDEX sl_cache_at ON sl_cache (at);`,
  // v45 (Chat agent, review I2): when the owner was told about this handoff. Lives on the row (erased by wa_id with the contact), not as a phone-keyed agent_state key.
  `ALTER TABLE agent_handoffs ADD COLUMN notified_at INTEGER;`,
  // v46 (self-service inbox tools, A25): the merchant's own quick replies for the composer. Text is unique; the API caps the list at 20.
  `CREATE TABLE quick_replies (
     id INTEGER PRIMARY KEY,
     text TEXT NOT NULL,
     position INTEGER NOT NULL,
     created_by TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX quick_replies_text ON quick_replies (text);`,
  // v47 (Ruling WA-RECS-1): post-order product recommendations are proactive messages to customers, so they are OFF for a workspace that existed before this deploy and
  // ON for one created after it. The marker lives in workspace_meta, a table that is NOT in BACKUP_TABLES (agent_state is, and a restore needs every backed-up table empty,
  // so migrate() must never write into one). migrate() inserts the marker only when no migration had ever run (a brand-new workspace); no row = OFF.
  `CREATE TABLE workspace_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v48 (Ruling CHAT-RECS-SWITCH-1): what the proactive post-order suggestion did for this order ('sent', 'skipped:<reason>', 'failed:enqueue'); NULL = not decided yet. It is the
  // idempotency claim (one decision per order) and the customer frequency cap. Lives on store_orders, so it is erased with the customer (by wa_id) and backed up with the order.
  `ALTER TABLE store_orders ADD COLUMN recs_outcome TEXT;
   ALTER TABLE store_orders ADD COLUMN recs_at INTEGER;`,
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
    // Ruling WA-RECS-1: a brand-new workspace (no migration had ever run) is marked ON; every older one has no marker and reads OFF. Never agent_state (backed up, restore needs it empty).
    if (done === 0) sql.exec("INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('recs_default_on', '1')");
  });
}
