# meta_deletion_needs_review (P1)
**Severity:** P1 look today
## What it means
Meta's data-deletion callback (`POST /meta/data-deletion`, `src/core/meta/data-deletion.ts`) received a genuine signed request but could not finish it alone. Fields: `reason` = `no_matching_connection` (no `waba_signup_users` row carries the hash of the person's app-scoped id, so there is nothing we can find), `stuck` (the request used all its attempts without finishing; the daily sweep gave up)  or `failed` (an error while removing connections; `error` is its class). The request row is in D1 `meta_deletion_requests` with state `nothing_found` or `failed`, and the person's status page says "a person on our team will review".
## Impact
A person asked Meta to delete their data and we have not proven it is done. This is a data-protection obligation with a clock, not an outage.
## Check first
1. Find the request: `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT code, state, received_at FROM meta_deletion_requests ORDER BY received_at DESC LIMIT 5"` (the Meta user id is not stored, only a hash).
2. `no_matching_connection`: no `waba_signup_users` row carries this person (they connected before the server recorded who connected, Meta named no user for the token, or they never connected a number). Ask support (docs/support.md) to write to the merchant to identify the store. `stuck`: the request used all 5 attempts without finishing; the daily sweep gave up and set it `failed`.
3. `failed`: read the Worker logs around `received_at` for the error class; a Meta API error during the deregister/unsubscribe step is retryable by hand.
## Fix
1. Identify the workspace. The callback never disconnects numbers by itself: ask the OWNER whether that person should keep access, and disconnect only on their word (Numbers screen, or as an operator with a reason `POST /api/v1/operator/workspaces/:workspaceId/numbers/:phoneNumberId/disconnect`).
2. Mark the request finished: Not documented in code: ask the engineer on call (there is no operator route that sets a request to done; set it with a one-off `UPDATE meta_deletion_requests SET state = 'done', finished_at = <now> WHERE code = '<code>'` only after step 1 is verified).
3. Reply to the person through support with the confirmation code.
## Verify it is resolved
`GET /meta/data-deletion/status?code=<code>` answers `done`, and the person's `waba_signup_users` rows are gone.
## Related
docs/launch/README.md section 4; docs/legal/README.md; docs/support.md
