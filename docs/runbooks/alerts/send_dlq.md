# send_dlq (P1)
**Severity:** P1 look today
## What it means
A send job exhausted its queue retries and landed in the dead-letter queue `ebda-wa-send-dlq`; `consumeSendDlq` in `src/core/send-queue.ts` raises this alert. Fields: `workspace`, `kind`, `attempts`, `state` (`failed`, `claimed`, `other` or `unknown`), or `reason: invalid_job` when the queue body is not a valid send job.
## Impact
One outbound message did not reach Meta. A merchant's customer did not get it. No money is lost: an unsent message has its wallet hold released.
## Check first
1. Search logs for `{"alert":"send_dlq"...}`; note `workspace`, `state`.
2. `state: failed` means the message is already marked `failed` with `error_reason = send_dlq` and its hold is released. `claimed` may be in flight to Meta and is left to the stale-claim recovery. `unknown` means the workspace Durable Object call failed.
3. Look for `business_token_unavailable` or Meta errors for the same workspace.
4. Read docs/runbooks/alerts.md, section send_dlq.
## Fix
1. For `failed`: check Meta status and the number's token, then ask the merchant to resend. The system does not resend.
2. For `claimed`: the stale-claim recovery handles it; no action unless it repeats.
3. For `unknown` or `invalid_job`: Not documented in code: ask the engineer on call.
## Verify it is resolved
New sends from the workspace succeed and no further `send_dlq` lines appear.
## Related
docs/runbooks/alerts.md; docs/messaging-core.md
