# Ebda WhatsApp Phases 2–3 (Messaging core + Inbox UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fast, complete messaging core (send, templates, opt-out, Meta-limit throttle, alarm scheduler, inbox API, realtime, media) and an Ebda-branded, Arabic-first inbox UI designed with impeccable, all on Cloudflare.

**Architecture:** Two tracks that meet at one contract file, `src/core/api/contract.ts` (Zod schemas + TypeScript types), committed first on `feat/phase2-messaging` and merged into `feat/phase3-inbox` before UI work starts. Track A (backend, branch `feat/phase2-messaging`) extends `WorkspaceDO` and the Hono API. Track B (UI, branch `feat/phase3-inbox`) is a React + Vite SPA in `web/`, built into `web/dist` and served by the same Worker through Workers static assets (`assets` binding, SPA fallback). Realtime is a WebSocket per workspace using the DO WebSocket Hibernation API (no cost while idle).

**Tech Stack:** program plan stack; UI: React 19, Vite 7 (latest versions ≥ 2 weeks old at install time, recorded in the ledger), no CSS framework unless impeccable's direction calls for one; fonts self-hosted from the brand pack's licensed families (Playfair Display, Inter) plus an Arabic face chosen in the design round.

**Spec:** `docs/plans/done/2026-10-24-ebda-whatsapp.md` (Phases 2–3 rows, Global Constraints), `PRODUCT.md`, the Store contract (`business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md`), and Ahmad's 2026-10-24 confirmations: templates, opt-out, Meta-limit throttle, alarm scheduler; inbox UI with Ebda branding redesigned through impeccable; messaging fast; all on Cloudflare.

## Global Constraints
- Program plan Global Constraints, Phase 1 constraints (identity v1, buyerKey, no PII to logs/Sentry).
- Ahmad 2026-10-24: push allowed, **no CI, no merge, no deploy**; light Mac load (touched tests per task, no Docker/Postgres, a Vite dev server only during the UI audit gate, stopped after).
- Max 2 agents at once (Track A Sonnet agent + one final Opus review).
- Workspace id = store id for Ebda stores (Phase 1 ruling); every route is under `/api/v1/stores/:storeId/` behind `requireStoreAccess`.
- Speed targets (measured locally in tests with timing assertions where deterministic, and live after deploy): conversation list p95 < 150 ms server time for 50 rows; open chat (last 50 messages) p95 < 150 ms; send → Meta accepted p95 < 1.5 s; UI first load < 150 KB gzip JS, interactive < 1.5 s on a mid phone on 4G.
- Meta: opted-out contacts never receive marketing; a free-form send outside the 24 h window is refused with `window_closed` and the UI offers templates; error 131049 is rescheduled, never treated as a ban.
- UI: Arabic-first RTL, Egyptian Arabic copy, English second, both complete; no orange; Ebda brand pack assets; WCAG 2.2 AA, 44 px targets, keyboard complete, reduced motion; no fabricated customers presented as real (sample data labelled).

## Review Focus
1. **A burst of 500 sends** on a number at the 250-unique-customer tier: replies to existing conversations go out, new business-initiated recipients beyond the tier wait and are reported, nothing is dropped → Task A4 tests.
2. **STOP written loosely** (`stop`, ` STOP!`, `إلغاء`, `الغاء`, `وقف الرسائل`) opts out; a normal message containing "stop" mid-sentence does not → Task A3 tests.
3. **Two alarms due at once** (backup and a throttled send) both run, and one failing does not block the other → Task A5 tests.
4. **The WebSocket reconnects** after the DO hibernates or the phone sleeps, and missed events are fetched by cursor, not lost → Tasks A7 + B5.
5. **RTL layout with mixed Arabic/English/numbers** (order numbers, prices in EGP, phone numbers) renders in the right order; long words never overflow the bubble → Task B4 checks.

---

## Track A — Messaging core (branch `feat/phase2-messaging`, one Sonnet agent)

### Task A0: API contract (written by the controller before the agent starts)
**Files:** `src/core/api/contract.ts`, `test/contract.test.ts`. Produces every request/response/event schema below; the UI imports the same file.

### Task A1: Send API (text, template, interactive, media)
**Files:** `src/core/meta/client.ts` (add `sendTemplate`, `sendInteractive`, `sendMedia`), `src/core/send-queue.ts` (job kinds), `src/core/workspace-do.ts` (`queueOutbound`), `src/routes/messages.ts`, `test/send-api.test.ts`.
- `POST /conversations/:conversationId/messages` body = `SendMessageRequest` (discriminated on `type`: `text` | `template` | `interactive` | `media`, plus `clientId` uuid). Returns 202 `MessageDto` with `status: 'queued'` immediately (optimistic UI matches on `clientId`), enqueues one `SendJob` with `idempotencyKey = 'ui:' + clientId`.
- Refusals: `window_closed` (409) for free-form outside 24 h; `opted_out` (409) for marketing templates to an opted-out contact; `template_not_approved` (409).
- Tests: each type reaches Meta with the exact Graph body; duplicate `clientId` → one send; window and opt-out refusals.

### Task A2: Templates
**Files:** `src/core/templates.ts`, DO migration (`templates` table: name, language, category, status, components JSON, rejected_reason, updated_at), `src/routes/templates.ts`, `src/addons/ebda/templates.ts` (Ebda's default Egyptian-Arabic set: `order_confirmation`, `cod_confirmation`, `shipping_update`, `otp_code`), `test/templates.test.ts`.
- `GET /templates`, `POST /templates` (submit to Meta), `POST /templates/sync` (pull from Meta: `GET /{waba-id}/message_templates`), template-status webhooks update status.
- `renderTemplateComponents(template, params)` validates parameter count/types before sending (ports the old `buildSendComponents` rules: header formats, URL-button placeholders).
- Tests: sync upsert, param count mismatch refused, rejected/paused template refused, status webhook applied.

### Task A3: Opt-out and consent
**Files:** `src/core/consent.ts`, DO migration (`contacts.opted_out_at`, `consent_source`, `consent_at`), `test/consent.test.ts`.
- `detectOptOut(text): boolean`: the whole message, after trimming punctuation/spaces/emoji, normalising Arabic alef forms and tatweel, equals one of `stop`, `unsubscribe`, `إلغاء`/`الغاء`, `وقف`, `وقف الرسائل`, `الغاء الاشتراك`; mid-sentence use never matches. `detectOptIn`: `start`, `ابدأ`/`ابدا`, `اشترك`.
- Inbound opt-out sets `opted_out_at` and auto-sends nothing (Meta best practice: confirm once with a utility reply is optional; spike: none).
- Marketing sends check consent; utility/authentication pass.

### Task A4: Meta-limit throttle
**Files:** `src/core/throttle.ts`, DO migration (`send_slots` / per-number counters), `test/throttle.test.ts`.
- Three separate controls: (1) **tier**: unique business-initiated recipients per rolling 24 h per number (from `phone_numbers.messaging_tier`, refreshed by quality/tier webhooks; default 250), replies inside an open window do not count; (2) **throughput**: token bucket per number at Meta's MPS (default 80/s, 1000/s for high-throughput numbers) held in the DO, jobs that find no token are delayed via the scheduler; (3) **131049**: reschedule that recipient +24 h, never mark the contact bad.
- Tests: Review Focus 1; token bucket math; 131049 reschedule.

### Task A5: Alarm scheduler
**Files:** `src/core/scheduler.ts`, DO migration (`scheduled_tasks(id, kind, due_at, payload, attempts)`), refactor `alarm()` to dispatch due tasks, `test/scheduler.test.ts`.
- `schedule(kind, dueAt, payload)` sets the single DO alarm to the earliest due task; `alarm()` runs every due task in isolation (one failure is recorded with backoff and does not stop others), then re-arms for the next earliest. Kinds: `backup`, `r2_drain`, `send_release`, `campaign_step` (Phase 6 placeholder, no-op handler).
- The Phase 1 backup and R2 drain move onto it (backup re-schedules itself daily at 02:00 Cairo).
- Tests: Review Focus 3; earliest-wins arming; backoff.

### Task A6: Inbox API
**Files:** `src/routes/conversations.ts`, DO methods (`listConversations`, `getMessages`, `markRead`, `assign`, `addNote`, `setTags`, `search`), DO migration (`notes`, `conversation_tags`, `conversations.assignee_user_id`, FTS5 `messages_fts` over `preview`), `test/inbox-api.test.ts`.
- `GET /conversations?filter=all|unread|mine|unassigned&cursor&limit≤50` sorted by `last_message_at DESC, id DESC` (keyset cursor); `GET /conversations/:id/messages?before&limit≤50`; `POST /conversations/:id/read`; `POST /conversations/:id/assign`; `GET|POST /conversations/:id/notes`; `PUT /conversations/:id/tags`; `GET /search?q` (FTS5, Arabic-normalised with the same normaliser at index and query time).
- Index every list/sort column. Timing tests: 5,000 conversations seeded, list 50 under the budget.

### Task A7: Realtime
**Files:** `src/core/realtime.ts`, DO `fetch` upgrade with `this.ctx.acceptWebSocket` (hibernation), `src/routes/ws.ts`, `test/realtime.test.ts`.
- `GET /api/v1/stores/:storeId/ws` upgrades after `requireStoreAccess` (token via `Sec-WebSocket-Protocol: bearer.<token>` because browsers cannot set headers on WebSocket). Events = `RealtimeEvent` (`message.created`, `message.status`, `conversation.updated`) each carrying a monotonic `seq`; the client resyncs with `GET /events?after=<seq>` (last 1,000 events kept in the DO).
- Tests: event fan-out on ingest/status/send; resync after a gap.

### Task A8: Media in/out
**Files:** `src/core/media.ts`, `src/routes/media.ts`, `test/media.test.ts`.
- Inbound image/audio/video/document/sticker: download via Graph media URL with the token, store in R2 `media/<workspace>/<wamid>`, keep mime + size; `GET /media/:wamid` streams from R2 after auth (never the expiring Meta URL).
- Outbound: upload to Meta (`POST /{phone-number-id}/media`) for allowed MIME types only (image/jpeg, image/png, audio/ogg;codecs=opus, video/mp4, application/pdf); others refused with `unsupported_media`.

### Task A9: Erasure follow-up
- A queued `SendJob` whose contact was erased is dropped by the consumer (contact missing + idempotency key not claimed) and logged without PII. Test: erase, then consume a queued reply → no Meta call.

### Task A10: Speed pass
- `scripts/bench-local.mjs` (light: miniflare in-process, no stack) prints p50/p95 for list, open chat, send-enqueue. Record numbers in `docs/perf/2026-10-phase2.md`, labelled measured (local) vs not yet measured (live).

---

## Track B — Inbox UI (branch `feat/phase3-inbox`, controller with impeccable)

### Task B1: Design direction (impeccable new-work, Operate mode)
- Surface inside the established Ebda brand world (logo pack + tokens). Run impeccable's surface concept round, present 3–4 structures to Ahmad, record his choice as the surface brief's direction contract. Code-led (Operate surfaces are code-led by rule).

### Task B2: App shell and build
**Files:** `web/` (Vite app), `web/src/main.tsx`, `web/src/api.ts` (typed client from `contract.ts`), `web/src/i18n/{ar,en}.ts`, `wrangler.jsonc` (`assets: { directory: "web/dist", not_found_handling: "single-page-application", binding: "ASSETS" }`, API routes still served by the Worker first via `run_worker_first: ["/api/*", "/meta/*", "/health"]`).
- Arabic default (`<html lang="ar" dir="rtl">`), language switch, self-hosted fonts, brand favicon/app icon/manifest.

### Task B3: Sign-in
- Against identity contract v1: redirect to `accounts.ebda.app` login, then `GET https://accounts.ebda.app/token?aud=whatsapp` (credentialed). Until the service exists, a clearly-labelled dev sign-in using the test issuer, only in `vite dev`, never in a production build (build-time guard + test).

### Task B4: Inbox screens (per the chosen direction)
- Conversation list (filters, unread, assignee, search), chat view (bubbles, statuses, media, day separators, 24 h window banner, template picker when closed), composer (quick replies, templates, attachments), order panel (collapsible on phone, persistent on desktop; sample orders until the Store RPC lands, labelled), notes/tags/assign.
- States: empty, loading (skeletons sized like content), offline, error, opted-out contact, window closed, sending/failed with retry.

### Task B5: Realtime client
- WebSocket with backoff + resync by `seq`; optimistic sends reconciled by `clientId`; list re-sorts on new messages without layout jumps.

### Task B6: Polish, audit, critique (impeccable)
- `impeccable polish`, `audit`, `critique`, detector; axe 0 violations at 390/820/1440 in ar and en; keyboard pass; reduced motion; contact sheets read (not sent to Ahmad); DESIGN.md written by the documenter at finish.

### Task B7: Serve from the Worker
- `npm run build` builds `web/dist`; Worker test asserts `/` serves the SPA, `/api/*` still hits Hono, unknown deep links fall back to `index.html`.

## Finish
Each track: touched tests per task, full suite once at the end, `tsc` 0, audit 0, gitleaks clean, pushed (no CI, no merge, no deploy). One Opus whole-branch review across both branches; one fix pass; Rulings collected for Ahmad.
