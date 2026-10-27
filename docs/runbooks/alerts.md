# Alerts: what reaches a human, and what to do

Every code path that used to write an ad-hoc `{ "alert": ... }` line now calls ONE function, `alert(name, fields)` in `src/core/observability.ts` (iceberg E1/E2). It always writes the same JSON log line; for **P0** and **P1** it also:

1. records a **Sentry event** (`captureMessage`, level `error` for P0, `warning` for P1; not a breadcrumb), and
2. sends **one Telegram message** to `TELEGRAM_ALERT_CHAT_ID` through `TELEGRAM_BOT_TOKEN` (the Ebda AI Studio alerts bot, the same chat as Ebda Store).

| Level | Meaning | Who |
|---|---|---|
| P0 | money or consent integrity is at risk (a ledger mismatch, a payment taken but not granted, a refund debit that did not finish) | wake someone now |
| P1 | degraded, a person must look today (a failed sweep, a dead-lettered send, a 5xx, a misconfigured secret) | same day |
| info | log only, no Sentry event, no Telegram | read in the weekly log pass |

A name's level is decided in `P0_ALERTS` / `P1_ALERTS` (observability.ts); a call may also pass `severity` explicitly. An unknown name is `info`.

## Behaviour you can rely on
- **Fire-and-forget**: the send goes through `waitUntil`; the caller never waits and never sees an error (Telegram down, Sentry down and a missing binding are all swallowed).
- **Throttled** per (name, workspace): one message per 10 minutes per isolate. The next one says `(suppressed N more since the last alert)`. The JSON log line is never throttled. Isolates restart, so a flapping alert can repeat at most once per isolate per 10 minutes.
- **No personal data**: phone numbers are masked (`maskPhones` plus a catch-all for any run of 8+ digits), and fields named like a phone, body, text, token, secret, code or e-mail are never rendered. Telegram shows the alert name, level, a shortened workspace id, the environment, this runbook link and a few scalar fields. The test `observability-alerts.test.ts` fails if a phone, body or secret appears.
- **Secrets unset** (`TELEGRAM_BOT_TOKEN` or `TELEGRAM_ALERT_CHAT_ID` missing): console + Sentry only. Set them with `npx wrangler secret put TELEGRAM_BOT_TOKEN` and `npx wrangler secret put TELEGRAM_ALERT_CHAT_ID` (values: the Store's bot token and chat id; ask Ahmad).
- A route that throws answers `500 {"error":"internal"}`, is captured in Sentry and raises `unhandled_error` (P1).
- The workspace Durable Object is wrapped with Sentry's instrumentation, so errors in its fetch, alarm and RPC methods reach Sentry.
- The send queue's dead letters (`ebda-wa-send-dlq`) are consumed: a message that never reached Meta is marked failed (`send_dlq`), its wallet hold released, and `send_dlq` (P1) is raised.

## Verify the channel (after setting the secrets and deploying)
Drill with the dead-letter queue, which touches no workspace: Cloudflare dashboard → Queues → `ebda-wa-send-dlq` → *Send message* → body `{}`. The consumer finds an invalid job and raises `send_dlq` (P1, `reason=invalid_job`). Expect within a minute: one Telegram message `🟠 Ebda WhatsApp: send_dlq [P1 PLATFORM]` and one Sentry event named `send_dlq [P1]`. Record the date of the drill here: ______

## Alerts worth a section
Search the code for the name in the Telegram text (`grep -rn "'<name>'" src`) to find where it fires. The ones you are most likely to meet:

### send_dlq
A send job exhausted its retries. The message is now `failed` with `error_reason = send_dlq`. Check Meta status / the number's token (`business_token_unavailable`), then ask the merchant to resend.

### unhandled_error
A route threw. Find the event in Sentry (search the route and the time); `route` and `method` are in the message.

### offboarding_failed / offboarding_held (P1)
A workspace deletion stopped. `GET /api/v1/operator/workspaces/:id/offboarding` shows `stepsDone` and `lastError` (the failing step and the error class, never its text). `held:<reason>` = money in flight (an open refund, card refund or payment): settle or reject it and the daily pass continues; `unfinished:r2` = more than 20,000 objects, it continues on the next pass. Re-run now with `POST /api/v1/operator/offboardings/run`. Steps are idempotent. Design: `docs/offboarding.md`.
### audit_write_failed / erasure_record_failed (P1)
`audit_write_failed`: an action went through but its `audit_log` row did not (D1 trouble). The Worker log has the line `{audit:"action"}` for it; check D1, then note the gap. `erasure_record_failed`: a contact was erased but its erasure record was not written, so a restore could bring the person back. Re-run `DELETE /api/v1/stores/:id/contacts/:waId` for the same contact (idempotent, rewrites the record) and confirm a row in `erasure_records`. Design: `docs/erasure-and-audit.md`.
### instapay_duplicate_proof (P1), billing_pass_backlog (P1), billing_pass_row_failed (P1), instapay_proof_purge_failed (P1)
`instapay_duplicate_proof`: an InstaPay request is held because its proof image or bank reference is on another request. Open the operator console's InstaPay queue, view both proofs, compare them with the bank app; release the genuine one (reason required) and reject the other. `billing_pass_backlog`: a daily money pass stopped after 50 pages; the next daily pass continues, look at what makes the backlog (a provider outage?). `billing_pass_row_failed`: one row threw inside a daily pass; the pass continued. `instapay_proof_purge_failed`: R2 refused a proof delete; retried tomorrow. Design: `docs/billing.md`.

### number_quality_flagged / number_error_spike (P1) and number_restricted (P0)
Meta flagged a number (FLAGGED counts as red), rated it red, restricted it, or 25 frequency-cap / undeliverable errors hit it in an hour (yellow). The workspace's campaigns on it are already paused (`quality_flagged`) and, for red / restricted, new templates are refused. Look at `phone_numbers.health_*` and the workspace's `number_health_log`; contact the merchant. Recovery never resumes campaigns: the merchant does. See `docs/number-health.md`.

### secret_misconfigured
`/health` is 503: a secret named in `REQUIRED_SECRETS` is missing or malformed. The key NAMES are in the alert (never values). Fix with `wrangler secret put`.

### entitlement_push_failed
A plan change could not be pushed to a workspace. The daily reconcile re-sends it; if it keeps firing, check the workspace Durable Object and `workspace_subscriptions` in D1.

### ledger_mirror_mismatch
The D1 mirror of a workspace's wallet ledger differs from the Durable Object ledger. Money may be wrong: stop top-ups for that workspace and follow `docs/billing.md` (mirror section).

### package_paid_not_granted, instapay_confirmed_not_granted
A payment is confirmed but the package was not granted. The daily repair grants it; if it fires twice, grant by hand through the operator route and reconcile.

### refund_debit_incomplete, card_refund_over_refundable
A refund did not complete or exceeds what the payment allows. Do not retry blindly: read `docs/billing.md` (refunds) first.
