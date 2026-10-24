# Messaging core (Phase 2)

Everything is under `/api/v1/stores/:storeId/` behind `requireStoreAccess`; the shapes are in `src/core/api/contract.ts`. A DO per workspace holds all tenant data; the Worker only validates and routes.

## Routes
| Route | Notes |
|---|---|
| `POST /conversations/:id/messages` | `text` / `template` / `interactive` / `media`; 202 + queued `MessageDto`; idempotent on `clientId`; refusals `window_closed`, `opted_out`, `template_not_approved`, `unsupported_media` (409/415), enqueue failure 503 |
| `GET /conversations?filter&cursor&limit` | keyset cursor `"<at>.<id>"`, ≤ 50 |
| `GET /conversations/:id/messages?before&limit` | oldest-first page; `nextBefore` = id of the page's oldest message when more exist |
| `POST /conversations/:id/read` · `/assign` · `PUT /tags` · `GET\|POST /notes` | return the updated `ConversationDto` / `NoteDto` |
| `GET /search?q` | FTS5 over message previews, Arabic-normalised both sides |
| `GET /messages/:id/body` | `{text}` for bodies over 1 KB |
| `GET /templates` · `POST /templates` · `POST /templates/sync` · `POST /templates/install-defaults` | submit and install-defaults are owner-only |
| `POST /media` (multipart `file`) · `GET /media/:messageId` | allow-list jpeg, png, ogg/opus, mp4, pdf; Range supported |
| `GET /throttle` | tier use and waiting sends for the active number |
| `GET /events?after=<seq>` · `GET /ws` | realtime |

## Realtime protocol
Open `GET /ws` with `Upgrade: websocket` and `Sec-WebSocket-Protocol: inbox.v1, bearer.<access token>`; the server answers `inbox.v1`. Frames are `RealtimeEvent` JSON, each with a growing `seq`. Send the text `ping` to get `pong` (answered without waking the DO). After every (re)connect call `GET /events?after=<last seq>`; if the first returned `seq` is greater than `after + 1` the gap was larger than the 1,000 retained events: reload the list. Upsert `message.created` by message id (it is sent again when an inbound file finishes downloading).

## Meta limits
Per number, inside the DO (`claimSend`): tier = unique business-initiated recipients (window closed) per rolling 24 h (default 250, updated from `phone_number_quality_update`), replies inside an open window never count; throughput = token bucket at MPS (default 80). A send over a limit goes back to `queued` and is released by the scheduler. Error 131049 reschedules +24 h (twice), never touches the contact.

## Scheduler
One DO alarm = earliest row of `scheduled_tasks`: `backup`, `r2_drain` (singletons, nightly 02:00 Africa/Cairo), `send_release`, `media_fetch`, `campaign_step` (Phase 6 placeholder). A failing task backs off 30 s → 1 h and never blocks the others.

## DO migrations added
v5 outbound foundation (message template/media columns, contact consent, `templates`, `uploads`) · v6 `scheduled_tasks` · v7 `number_limits`, `tier_slots` · v8 inbox (assignee, `notes`, `conversation_tags`, list indexes, `messages_fts`) · v9 `events` · v10 `erased_keys`.
