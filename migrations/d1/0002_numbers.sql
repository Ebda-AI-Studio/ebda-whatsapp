-- Phase 8.1: a merchant's own WhatsApp number (Embedded Signup). The business token lives encrypted per WABA (AES-GCM,
-- associated data = workspace id); a number without a credential row is a platform number and sends with the platform token.
CREATE TABLE waba_credentials (
  waba_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_enc TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('own')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX waba_credentials_workspace ON waba_credentials (workspace_id);

ALTER TABLE phone_numbers ADD COLUMN kind TEXT NOT NULL DEFAULT 'platform' CHECK (kind IN ('own', 'platform'));
ALTER TABLE phone_numbers ADD COLUMN onboarding TEXT CHECK (onboarding IN ('cloud_api', 'business_app'));
ALTER TABLE phone_numbers ADD COLUMN pin_enc TEXT;
ALTER TABLE phone_numbers ADD COLUMN verified_name TEXT;
ALTER TABLE phone_numbers ADD COLUMN quality_rating TEXT;
ALTER TABLE phone_numbers ADD COLUMN messaging_limit_tier TEXT;
ALTER TABLE phone_numbers ADD COLUMN throughput_level TEXT;
ALTER TABLE phone_numbers ADD COLUMN name_status TEXT;
ALTER TABLE phone_numbers ADD COLUMN platform_type TEXT;
ALTER TABLE phone_numbers ADD COLUMN is_on_biz_app INTEGER;
ALTER TABLE phone_numbers ADD COLUMN registration TEXT CHECK (registration IN ('pending', 'registered', 'failed', 'locked', 'not_needed'));
ALTER TABLE phone_numbers ADD COLUMN sync_requested_at INTEGER;
ALTER TABLE phone_numbers ADD COLUMN last_status_sync_at INTEGER;
-- Beyond the plan's list (Ruling WA-SIGNUP-COLS): resumable steps and the outcome of the two one-shot syncs.
ALTER TABLE phone_numbers ADD COLUMN connected_at INTEGER;
ALTER TABLE phone_numbers ADD COLUMN subscribed_at INTEGER;
ALTER TABLE phone_numbers ADD COLUMN history_sync TEXT CHECK (history_sync IN ('requested', 'refused', 'declined', 'received'));
ALTER TABLE phone_numbers ADD COLUMN contacts_sync TEXT CHECK (contacts_sync IN ('requested', 'refused', 'received'));
