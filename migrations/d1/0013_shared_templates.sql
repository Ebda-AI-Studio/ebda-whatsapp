-- Item e: the platform WABA's message templates. They belong to the platform, not to any store, so the catalog lives in the control plane
-- (definitions only: no message content, no phone numbers). Operators sync it from Meta and submit to it with the platform token; a store sending
-- from the shared number may use only an APPROVED UTILITY or AUTHENTICATION template found here (marketing is never sendable: WA-SHARED-NOCAMP-1).
CREATE TABLE shared_templates (
  phone_number_id TEXT NOT NULL REFERENCES shared_numbers(phone_number_id),
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  components TEXT NOT NULL,
  rejected_reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (phone_number_id, name, language)
) WITHOUT ROWID;
