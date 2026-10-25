-- Item e: the platform WABA's message templates. Meta templates belong to a WABA, not to a phone number, so the catalog is keyed by waba_id: every
-- shared number on that WABA sees the same row, and a pause blocks all of them. Definitions only: no message content, no phone numbers.
-- Operators sync it from Meta and submit to it with the platform token; a store sending from a shared number may use only an APPROVED UTILITY or
-- AUTHENTICATION template found here (marketing is never sendable: WA-SHARED-NOCAMP-1).
CREATE TABLE shared_templates (
  waba_id TEXT NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  components TEXT NOT NULL,
  rejected_reason TEXT,
  updated_at INTEGER NOT NULL,
  -- DATABASE clock (unixepoch('subsec'), seconds) of the last TIGHTENING of this row (rejected/paused/disabled/pending, or a move to marketing).
  -- A row loosens only from a fresh Graph read that STARTED after this moment, also taken from the database clock, so isolates cannot disagree.
  tightened_at REAL,
  PRIMARY KEY (waba_id, name, language)
) WITHOUT ROWID;

-- Webhooks and sends resolve number -> WABA and WABA -> numbers.
CREATE INDEX shared_numbers_waba ON shared_numbers (waba_id);
