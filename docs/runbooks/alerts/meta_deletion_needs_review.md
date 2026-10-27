# meta_deletion_needs_review (P1)
**Severity:** P1 look today
## What it means
Meta's data-deletion callback (`POST /meta/data-deletion`, `src/core/meta/data-deletion.ts`) received a genuine signed request but could not finish it alone. Fields: `reason` = `no_matching_connection` (no `waba_credentials.fb_user_id` equals the person's app-scoped id, so there is nothing we can find) or `failed` (an error while removing connections; `error` is its class). The request row is in D1 `meta_deletion_requests` with state `nothing_found` or `failed`, and the person's status page says "a person on our team will review".
## Impact
A person asked Meta to delete their data and we have not proven it is done. This is a data-protection obligation with a clock, not an outage.
## Check first
1. Find the request: `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT code, state, received_at FROM meta_deletion_requests ORDER BY received_at DESC LIMIT 5"` (the Meta user id is not stored, only a hash).
2. `no_matching_connection`: the person may have connected before the user id was recorded (connections made before 2026-10-27 have no `fb_user_id`), or they never connected a number. Ask support (docs/support.md) to write to the merchant to identify the store.
3. `failed`: read the Worker logs around `received_at` for the error class; a Meta API error during the deregister/unsubscribe step is retryable by hand.
## Fix
1. Identify the workspace, then disconnect its numbers from the app (Numbers screen, owner, or `POST /api/v1/stores/:storeId/numbers/:phoneNumberId/disconnect` as owner); that deletes the business token and PIN.
2. Mark the request finished: Not documented in code: ask the engineer on call (there is no operator route that sets a request to done; set it with a one-off `UPDATE meta_deletion_requests SET state = 'done', finished_at = <now> WHERE code = '<code>'` only after step 1 is verified).
3. Reply to the person through support with the confirmation code.
## Verify it is resolved
`GET /meta/data-deletion/status?code=<code>` answers `done`, and `SELECT count(*) FROM waba_credentials WHERE workspace_id = '<id>'` is 0 for the removed connection.
## Related
docs/launch/README.md section 4; docs/legal/README.md; docs/support.md
