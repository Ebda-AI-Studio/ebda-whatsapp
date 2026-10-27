-- B9 (W2-LEGAL): Meta's data-deletion callback. A person who removes the app makes Meta POST a signed request naming their app-scoped user id.
-- waba_credentials.fb_user_id is that id as reported by the browser at Embedded Signup (digits, nullable, additive); it is how a request finds the connections to remove.
ALTER TABLE waba_credentials ADD COLUMN fb_user_id TEXT;
CREATE INDEX waba_credentials_fb_user ON waba_credentials (fb_user_id) WHERE fb_user_id IS NOT NULL;

-- One row per request. The Meta user id is NOT kept here (only a hash, to recognise a retry); the code is derived from the payload with the app secret, so a retry gets the same code.
CREATE TABLE meta_deletion_requests (
  code TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'done', 'nothing_found', 'failed')),
  removed_connections INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER
);
