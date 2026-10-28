# media_fetch_abandoned (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/workspace-do.ts (scheduled task `media_fetch`) when downloading an inbound media file from Meta failed on all attempts (MEDIA_FETCH_MAX_ATTEMPTS = 8, retried for hours). Fields: `workspace`, `attempts`, `error` (an error class name).
## Impact
The inbound message is kept but without its media (image, audio, document). No money moves. Meta media ids live about 30 days, so the file may still be fetchable for a while.
## Check first
1. Search logs for `{"alert":"media_fetch_abandoned"...}` and note `workspace` and `error`.
2. Check whether the number's token is usable (look for `business_token_unavailable` in logs) and whether Meta was having an outage.
3. Read docs/messaging-core.md for the inbound media path.
## Fix
1. The system does not retry after the alert. Not documented in code: ask the engineer on call whether the media can be re-fetched.
2. If the token is the cause, fix the number's connection (the merchant reconnects through Embedded Signup, see docs/numbers.md).
3. The merchant can ask the customer to resend the file.
## Verify it is resolved
New inbound media in that workspace is stored and shown, and the alert stops.
## Related
docs/messaging-core.md; docs/numbers.md; send_dlq
