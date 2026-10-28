# send_enqueue_failed (P1)
**Severity:** P1 look today
## What it means
Fires from the send route in src/routes/messages.ts when a message was accepted into the workspace but putting its job on the send queue (`SEND_QUEUE`, `ebda-wa-send`) threw. The row is immediately marked failed (`markEnqueueFailed`), so no orphan `queued` row remains. Fields: `workspace`, `error` (the error message).
## Impact
That one outgoing message was not sent; the merchant's API call got `503 rate_limited` with message `enqueue_failed`. No consent or money issue; any hold for it is released with the failed row.
## Check first
1. Search logs for `{"alert":"send_enqueue_failed"` and note `workspace` and `error`.
2. Check Cloudflare dashboard, Queues, `ebda-wa-send` for platform problems.
3. Check whether `send_dlq` is also firing (docs/runbooks/alerts.md).
## Fix
1. Nothing is retried by the system: the caller is told 503 and must resend. If the queue is healthy again, ask the merchant (or their integration) to resend.
2. If it keeps firing for many workspaces, it is a Cloudflare Queues incident: check Cloudflare status and escalate to the engineer on call.
## Verify it is resolved
New sends return 202 and the alert stops; the failed messages show as failed in the workspace inbox.
## Related
docs/runbooks/alerts.md (send_dlq); docs/messaging-core.md; alert: business_token_unavailable
