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
| `GET /templates` · `POST /templates` · `POST /templates/sync` · `POST /templates/install-defaults` | submit and install-defaults are owner-only |
| `POST /media` (multipart `file`) · `GET /media/:messageId` | allow-list jpeg, png, ogg/opus, mp4, pdf; Range supported. Caps image 5 MB, audio/video 16 MB, document 50 MB. Upload needs `Content-Length` (411 without it, 413 over cap, both before the body is read); the file is read once and streamed to R2. GET is `Cache-Control: private, no-store` |
| `GET /throttle` | tier use and waiting sends for the active number |
| `GET /events?after=<seq>` · `GET /ws` | realtime |

## Realtime protocol
Open `GET /ws` with `Upgrade: websocket` and `Sec-WebSocket-Protocol: inbox.v1, bearer.<access token>`; the server answers `inbox.v1`. Frames are `RealtimeEvent` JSON, each with a growing `seq`. Send the text `ping` to get `pong` (answered without waking the DO). Each socket keeps its token's expiry (and the caller's role) as a hibernation attachment; at the next push after it passes the server closes it with code `4401` and sends it nothing, so the client refreshes its token and reconnects. After every (re)connect call `GET /events?after=<last seq>`; if the first returned `seq` is greater than `after + 1` the gap was larger than the 1,000 retained events: reload the list. Upsert `message.created` by message id (it is sent again when an inbound file finishes downloading).

## Templates, OTP and opt-out
Authentication templates are recognised by Meta's category `AUTHENTICATION` (Meta returns the copy-code button as type URL, so shape is not used): a send takes one parameter, the code goes only into the Graph job, and the stored `preview`/`body`, search index and events hold `••••••`. Residual: a throttled OTP job sits in `scheduled_tasks` (never backed up) until released. A MARKETING template that was deferred (tier, throughput, 131049) is re-checked when it is claimed: if the contact opted out meanwhile the message is marked `failed` with `error_reason = 'opted_out'` and Meta is not called; UTILITY and AUTHENTICATION still go. A template-status webhook is applied to every workspace with an active number on that WABA; a throttled job is released once per idempotency key.

## Meta limits
Per number, inside the DO (`claimSend`): tier = unique business-initiated recipients (window closed) per rolling 24 h (default 250, updated from `phone_number_quality_update`), replies inside an open window never count; throughput = token bucket at MPS (default 80). A send over a limit goes back to `queued` and is released by the scheduler. Error 131049 reschedules +24 h (twice), never touches the contact.

## Scheduler
One DO alarm = earliest row of `scheduled_tasks`: `backup`, `r2_drain` (singletons, nightly 02:00 Africa/Cairo), `send_release`, `media_fetch`, `campaign_step` (Phase 6 placeholder), and the Phase 4 kinds `catalog_sync`, `catalog_reconcile`, `cod_no_reply`, `cod_outcome_push`, `bot_turn` (see store-link.md). A failing task backs off 30 s → 1 h and never blocks the others.

## DO migrations added
v5 outbound foundation (message template/media columns, contact consent, `templates`, `uploads`) · v6 `scheduled_tasks` · v7 `number_limits`, `tier_slots` · v8 inbox (assignee, `notes`, `conversation_tags`, list indexes, `messages_fts`) · v9 `events` · v10 `erased_keys` · v11 task `lease_until` · v12 `messages.error_reason` · v13-v15 Store link tables (see `docs/store-link.md`).

## Phase 4 additions to the messaging core
Send jobs gained two kinds, `list` (interactive list) and `image_link` (image by https link), and template parameters may carry a quick-reply `payload`. Inbound parsing now exposes button/list replies and template quick-replies (`type: interactive`, text = the tapped title) and Meta carts (`type: order`). Commerce behaviour: `docs/store-link.md`.
