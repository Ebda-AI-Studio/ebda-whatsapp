# Messaging core (Phase 2)

Everything is under `/api/v1/stores/:storeId/` behind `requireStoreAccess`; the shapes are in `src/core/api/contract.ts`. A DO per workspace holds all tenant data; the Worker only validates and routes.

## Routes
| Route | Notes |
|---|---|
| `POST /conversations/:id/messages` | `text` / `template` / `interactive` / `media`; 202 + queued `MessageDto`; idempotent on `clientId`; refusals `window_closed`, `opted_out`, `template_not_approved`, `unsupported_media` (409/415), enqueue failure 503 |
| `GET /conversations?filter&cursor&limit` | keyset cursor `"<at>.<id>"`, ≤ 50 |
| `GET /conversations/:id/messages?before&limit` | oldest-first page; `nextBefore` = id of the page's oldest message when more exist |
| `POST /conversations/:id/read` · `/assign` (userId must be null, the caller, or a user already assigned in this workspace; else 400 `unknown_assignee`; staff lists arrive with the Store in Phase 4) · `PUT /tags` · `GET\|POST /notes` | return the updated `ConversationDto` / `NoteDto` |
| `GET /search?q` | FTS5 over message previews, Arabic-normalised both sides |
| `GET /messages/:id/body` | `{text}` for bodies over 1 KB |
| `GET /templates` · `GET /templates/:name/:language` · `POST /templates/check` · `POST /templates` · `PUT` / `DELETE /templates/:name/:language` · `POST /templates/sync` · `POST /templates/install-defaults` | merchant self-service on the store's OWN number, see "Templates self-service" below; `check`, list, detail and sync are free (staff may use them), create / edit / delete / install-defaults are owner-only. No active own number = `404 { error: 'not_found', message: 'no_active_number' }` |
| `POST /media` (multipart `file`) · `GET /media/:messageId` | allow-list jpeg, png, ogg/opus, mp4, pdf; Range supported. Caps image 5 MB, audio/video 16 MB, document 50 MB. Upload needs `Content-Length` (411 without it, 413 over cap, both before the body is read); the file is read once and streamed to R2. GET is `Cache-Control: private, no-store` |
| `GET /throttle` | tier use and waiting sends for the active number |
| `GET /events?after=<seq>` · `GET /ws` | realtime |

## Realtime protocol
Open `GET /ws` with `Upgrade: websocket` and `Sec-WebSocket-Protocol: inbox.v1, bearer.<access token>`; the server answers `inbox.v1`. Frames are `RealtimeEvent` JSON, each with a growing `seq`. Send the text `ping` to get `pong` (answered without waking the DO). Each socket keeps its token's expiry (and the caller's role) as a hibernation attachment; at the next push after it passes the server closes it with code `4401` and sends it nothing, so the client refreshes its token and reconnects. WA-6: a socket lives at most 10 minutes whatever the token says (`WS_MAX_LIFETIME_S`), the upgrade is session-checked like a sensitive read, and a `ws_sweep` task re-checks every open socket each minute: a revoked session or a person no longer a Store member is closed with `4403` (an unanswerable check leaves the socket until the next sweep; the cap bounds that window). After every (re)connect call `GET /events?after=<last seq>`; if the first returned `seq` is greater than `after + 1` the gap was larger than the 1,000 retained events: reload the list. Upsert `message.created` by message id (it is sent again when an inbound file finishes downloading).

## Templates, OTP and opt-out
Authentication templates are recognised by Meta's category `AUTHENTICATION` (Meta returns the copy-code button as type URL, so shape is not used): a send takes one parameter, the code goes only into the Graph job, and the stored `preview`/`body`, search index and events hold `••••••`. Residual: a throttled OTP job sits in `scheduled_tasks` (never backed up) until released. A MARKETING template that was deferred (tier, throughput, 131049) is re-checked when it is claimed: if the contact opted out meanwhile the message is marked `failed` with `error_reason = 'opted_out'` and Meta is not called; UTILITY and AUTHENTICATION still go. A template-status webhook is applied to every workspace with an active number on that WABA; a throttled job is released once per idempotency key.

## Templates self-service
One service (`src/core/templates-service.ts`) is the only template API: the Templates screen and the AI Smart Layer call the same routes, and the routes are thin wrappers (`src/routes/templates.ts`). Policy: `checkOnly`, `syncTemplates`, `refreshPending` are free; `createTemplate`, `editTemplate`, `deleteTemplate`, `installDefaults` are confirm (a submission to Meta cannot be recalled). Failures are values (`invalid`, `exists`, `not_found`, `not_editable`, `edit_limit` with `retryAt`, `in_use`, `not_deletable`, `payload_changed`, `token_unavailable`, `meta_unavailable`, `meta_rejected`), mapped to HTTP in one place (`failed()` in the route file); Meta's own text travels in `message`.
- **The draft** (`TemplateDraft`, `templateDraftSchema` in the contract): `{ name, label, language, category, header, body: { text, examples }, footer, buttons[], auth? }`. `toMetaComponents` builds Meta's components (positional examples, authentication as the fixed OTP form); `fromStoredComponents` is its inverse for editing. The old POST body (`{ name, language, category, components }`) is still accepted and converted.
- **Meta's rules** live in `src/core/meta/template-rules.ts` (`checkTemplate`, limits copied from Meta's docs with their URLs, verified 2026-11-14) and are shared by the screen (instant feedback) and the server (the gate). Messages are in `template-rule-copy.ts` (Egyptian Arabic first). What Meta did not state (promotional wording, variable density) is a warning, never a blocker. Text headers only (Ruling `TPL-MEDIA-1`).
- **Payload hash**: `POST /templates/check` returns `payloadHash` (SHA-256 of the canonical draft); create and edit take `expectedHash` and answer `409 payload_changed` when the draft is not the one that was checked, so what was confirmed is what is submitted.
- **Idempotency**: a name+language is claimed in the DO (`reserveTemplate`, atomic) BEFORE the Meta call, so two taps or two staff tabs can never both submit; a refused submission releases the claim. The stored category is Meta's answer (`categoryChanged` tells the screen).
- **Edit limits**: APPROVED templates may be edited once per 24 h and 10 times per 30 days (`template_edits` log, `editAllowance`); only edits of APPROVED templates are logged (Ruling `TPL-EDIT-COUNT-1`). An APPROVED template's category is locked.
- **Delete** removes ONE language through Meta's `hsm_id` (the id is looked up first, never a delete-by-name that would drop every language); a template still used by a draft / scheduled / running / paused campaign or a queued message is refused (`in_use`); a DISABLED one cannot be deleted.
- **Status**: the webhook (`message_template_status_update`, now carrying the template id and `PENDING_DELETION`) updates the row; a lost or early webhook is repaired by the `template_refresh` task, armed by a submission, which asks Meta by name once a row is PENDING for an hour and stops when none is. Rejection advice (`template-advice.ts`) is derived from the reason KIND only; the raw code is shown beside it.
- **Starter set on connect**: `installStarterOnConnect` (after a number's connect or resume, deferred with the request's `waitUntil`) syncs Meta first (existing templates are adopted), submits only the missing starters and writes `store_state` `templates.starter:<wabaId>` = `done` only when nothing failed; failure raises the `starter_templates_failed` alert and the screen's install-defaults call is the retry path. The shared number's WABA never gets starters.
- DO migration v42 (additive): `templates.meta_id`, `label`, `submitted_at`, table `template_edits`.

## Meta limits
Per number, inside the DO (`claimSend`): tier = unique business-initiated recipients (window closed) per rolling 24 h (default 250, updated from `phone_number_quality_update`), replies inside an open window never count; throughput = token bucket at MPS (default 80). A send over a limit goes back to `queued` and is released by the scheduler. Error 131049 reschedules +24 h (twice), never touches the contact.

## Scheduler
One DO alarm = earliest row of `scheduled_tasks`: `backup`, `r2_drain` (singletons, nightly 02:00 Africa/Cairo), `send_release`, `media_fetch`, `campaign_step` (the Phase 6 campaign sweep, `docs/campaigns.md`), and the Phase 4 kinds `catalog_sync`, `catalog_reconcile`, `cod_no_reply`, `cod_outcome_push`, `bot_turn` (see store-link.md), and the Phase 7 kinds `subscription_expire`, `wallet_wait`, `wallet_sweep`, `ledger_drain`, `shared_number_trueup` (see billing.md). A failing task backs off 30 s → 1 h and never blocks the others.

## DO migrations added
v5 outbound foundation (message template/media columns, contact consent, `templates`, `uploads`) · v6 `scheduled_tasks` · v7 `number_limits`, `tier_slots` · v8 inbox (assignee, `notes`, `conversation_tags`, list indexes, `messages_fts`) · v9 `events` · v10 `erased_keys` · v11 task `lease_until` · v12 `messages.error_reason` · v13-v15 Store link tables (see `docs/store-link.md`).

## Phase 4 additions to the messaging core
Send jobs gained two kinds, `list` (interactive list) and `image_link` (image by https link), and template parameters may carry a quick-reply `payload`. Inbound parsing now exposes button/list replies and template quick-replies (`type: interactive`, text = the tapped title) and Meta carts (`type: order`). Commerce behaviour: `docs/store-link.md`.

## Campaigns
Broadcasts reuse this pipeline unchanged (queueTemplate, claim, tier, MPS, 131049, opt-out re-check at claim time); see `docs/campaigns.md`. Campaign message keys are `camp:<campaignId>:<contactId>`; `scheduled_tasks.send_release` rows with reason `campaign_paused` are a paused campaign's parked sends.
