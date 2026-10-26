# Iceberg audit fixes (Ruling AUDIT-ALL-1): ledger + plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** close EVERY finding of the Iceberg audit (report: `~/Desktop/projects/Ebda-AI-Studio/business/ebda/audits/2026-10-26-iceberg-whatsapp.md`, origin/main 1839ba5), in two waves, each PR through the merge gate.

**Spec:** Ruling AUDIT-ALL-1 (Ahmad, via the controller, 2026-10-26): every finding is fixed, all severities. Wave 1 is required before the GO-1 deploy; wave 2 before ANY real merchant or customer sends (the launch gate). A2/A1 (Meta quality auto-pause) and F3 (operator kill switch) are mandatory before `SHARED_NUMBER_ENABLED` is ever switched on. B2 (workspace deletion) follows the Store's OFFBOARD-1 design: keyed-HMAC pseudonyms only for records the law requires (money), everything else deleted, R2 media and imports included. Alerts reach the same human channel as the Store (Telegram alert bridge + Sentry captured as an EVENT, not a breadcrumb), verified live after the deploy by triggering one alert on purpose. Opus review on B2, B3 and F1 (and on every money-touching PR).

## Global Constraints
- Same repo rules as every plan (CLAUDE.md): `src/core/**` never names Ebda; no raw phone or message body in logs, alerts or Telegram; Zod at every edge; tests first (seen red), mutation-checked for gates; heavy suites only under the host lock; `git add` specific paths.
- Telegram: `TELEGRAM_BOT_TOKEN` (secret) + `TELEGRAM_ALERT_CHAT_ID` (secret) on the WhatsApp Worker, the SAME channel as the Store; unset = console + Sentry only (graceful, like the Store's alerts.service).
- An alert never throws into the caller and never blocks a money or send path (fire-and-forget via `ctx.waitUntil` / DO `waitUntil`), and is throttled per alert name + workspace (no storms).

## Ledger (every finding; wave; PR; status)
| ID | Finding (short) | Wave | PR group |
|---|---|---|---|
| E1 / T24 | `alert` lines reach no human | 1 | **W1-OBS** |
| E2 / T26 | Sentry blind: no `app.onError`, DO not wrapped, alerts are breadcrumbs | 1 | **W1-OBS** |
| C1 | `/kashier/webhook` outside `run_worker_first`, no prod probe | 1 | **W1-OBS** |
| E4 | no uptime monitor on `/health` | 1 | **W1-OBS** (Cloudflare health check or cron self-probe → alert) |
| E5 | send DLQ has no consumer/alert | 1 | **W1-OBS** |
| E3 / T23 | log retention unproven (Logpush) | 1 | **W1-OBS** (Logpush job via API + runbook + verify) |
| B1 | import CSV kept forever, outside erasure | 1 | **W1-PRIV** |
| A2 | "Stop" quick-reply button tap is not an opt-out | 1 | **W1-PRIV** |
| A3 | opt-out vocabulary narrow (Arabic/English forms) | 1 | **W1-PRIV** |
| B7 | parked shared-number R2 objects not removed by erasure | 1 | **W1-PRIV** |
| A1 / A5 | Meta quality / account events ignored; no auto-pause on FLAGGED/RED or block spikes | 2 (before shared number) | **W2-META** |
| A7 | shared number: no operator route to evict / quality view | 2 (before shared number) | **W2-META** |
| F3 | no operator kill switch (suspend workspace, pause sends/campaigns, evict, revoke tokens) | 2 (before shared number) | **W2-OPS** |
| B2 | no workspace/account deletion (OFFBOARD-1) | 2 | **W2-OFFBOARD** (Opus) |
| B3 | erasure record is a log line; restore re-creates erased contacts | 2 | **W2-ERASE** (Opus) |
| T8 | workspace staff actions only in console logs (no audit log) | 2 | **W2-ERASE** (append-only audit_log) |
| F1 | no per-customer AI turn cap | 2 | **W2-ABUSE** (Opus) |
| F4 | no per-workspace / per-token API rate limit | 2 | **W2-ABUSE** |
| F5 | spam campaigns: no new-workspace daily cap / content guard | 2 | **W2-ABUSE** |
| F6 | `/t/:code` wakes a DO before validating; webhook reads body before size check | 2 | **W2-ABUSE** |
| B6 | raw buyer text to the LLM (phones, card numbers unmasked) | 2 | **W2-ABUSE** (mask before the model) |
| F2 | prompt-injection hardening (instruction boundary, tool-call caps) | 2 | **W2-ABUSE** |
| A4 | consent proof thin (who attested, wording, timestamp) | 2 | **W2-CONSENT** |
| B4 / T7 | no message retention policy / purge; R2 media + instapay-proof lifecycle | 2 | **W2-RETENTION** |
| B5 | no data-subject export | 2 | **W2-RETENTION** |
| C2 | InstaPay duplicate-proof detection; proof objects never deleted | 2 | **W2-MONEY** (Opus) |
| D1 | members RPC (contract v1.4) absent | 2 | = P1b (packages plan) |
| D3 | `store.plan_changed` status/periodEnd optional | 2 | **W2-CONTRACT** |
| D4 | SUITE_BUYER_KEY_SECRET equality across Workers unproven | 2 | **W2-CONTRACT** (vector check in verify-prod) |
| T21 | DR: no off-Cloudflare copy installed; D1 Time Travel undocumented; `bodies/` not in nightly backup | 2 | **W2-DR** |
| T29 | no rollback runbook; DO migrations not enforced additive | 2 | **W2-DR** |
| T25 | no incident runbooks per P1 alert | 2 | **W2-DR** (one runbook per P1 alert, linked from the alert) |
| T17 | per-workspace scale ceiling untested; backup export one transaction | 2 | **W2-SCALE** (500k seed spike; chunked export) |
| T12 | no signup-to-paid funnel | 2 | **W2-GROWTH** |
| T13 | no merchant weekly usage digest | 2 | **W2-GROWTH** |
| T26b | no p95-by-stage dashboard / per-workspace cost view | 2 | **W2-GROWTH** |
| T32 | billing notifications not evidenced; no per-workspace cost view | 2 | **W2-GROWTH** |
| T33 / T34 / T35 | support intake, merchant escalation path, platform-support routes | 2 | **W2-SUPPORT** (docs + operator "view as merchant" with audit) |
| B9 | legal texts drafts; Meta data-deletion URL points elsewhere | 2 | **W2-LEGAL** (own deletion URL; lawyer review is Ahmad's) |
| T20 | DO location hint for PDPL residency | 2 | **W2-RETENTION** (document; jurisdiction hint if available) |

Verified-OK items in the report (C3, C4, C5, C6, D2, D5, E6, F7, B8, A6) need no work; T5/T19/T36/T37 are N/A; T11/T14 are covered by #18/#20/P2; T28 is accepted by INFRA-PREVIEW-1.

## Wave 1 tasks (before GO-1)

### W1-OBS: alerts reach a human; Sentry sees errors; Kashier routed; uptime; DLQ; log retention
- `src/core/observability.ts`: ONE `alert(name, { severity: 'P0'|'P1'|'info', workspace?, ...fields })` used everywhere a code path writes `{ alert: ... }` today (sweep every `alert:` JSON line in src; keep the JSON line). P0/P1 → Sentry `captureMessage` as an event (level error/warning, tags name + workspace, fields as extras, phones masked) and Telegram `sendMessage` to `TELEGRAM_ALERT_CHAT_ID` (text: name, severity, workspace, the runbook link; never a phone or body). Throttle: one per (name, workspace) per 10 min per isolate + a DO-side counter for the summary. Unset secrets = console + Sentry only.
- `app.onError` → Sentry capture + 500 JSON; wrap `WorkspaceDO` with Sentry's DO instrumentation (or a manual try/capture in fetch/alarm/RPC entry points).
- `wrangler.jsonc` `run_worker_first` adds `/kashier/*`; `test/assets-config.test.ts` pins it; `scripts/verify-prod.mjs` probes `POST /kashier/webhook` with an unsigned body and expects the Worker's 401/400 (not the SPA HTML).
- Uptime: a Cloudflare Health Check on `https://wa.ebda.app/health` (API, documented) or, if unavailable on the plan, the daily cron + an external probe documented; failure → Telegram.
- DLQ: a consumer for `ebda-wa-send-dlq` that marks the message failed (if not already) and raises `send_dlq` P1.
- Logpush: create the job (R2 `ebda-wa-logs`, 30-day lifecycle) via the Cloudflare API, record the job id in docs/runbooks/cloudflare-account.md, verify objects appear.
- Tests: alert → Sentry event + Telegram call (stubbed fetch to api.telegram.org via the network guard's stub), throttle, no phone in the Telegram text (mutation-checked), onError captures, kashier route served by the Worker, DLQ consumer.

### W1-PRIV: imports, Stop button, opt-out vocabulary, parked shared R2
- Import CSV: delete `imports/<store>/<id>.csv` when the import finishes (done or failed, after rejects are recorded) and on contact erasure of anything it still references; R2 lifecycle on `imports/` (7 days) as the backstop (scripts/cf-resources.sh).
- Opt-out: treat an interactive button/list reply whose title or id matches the opt-out vocabulary as STOP (same path as text); widen the vocabulary (Egyptian Arabic + English common forms) in ONE list, normalised with `normaliseText`.
- `eraseSharedFor` also deletes the `shared-parked/` R2 objects of that sender (queued delete with retry like r2_pending_deletes).
- Tests for each, red first.

## Wave 2
Each W2 group above becomes one PR with its own short brief at the time it starts; Opus review on W2-OFFBOARD, W2-ERASE, W2-ABUSE (F1), W2-MONEY. Order: W2-META + W2-OPS first (shared-number gate), then OFFBOARD, ERASE, ABUSE, CONSENT, RETENTION, MONEY, CONTRACT, DR, SCALE, GROWTH, SUPPORT, LEGAL.
