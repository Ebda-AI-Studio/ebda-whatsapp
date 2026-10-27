# The shared platform number (Phase 8.2)

Backend only. Switch: `SHARED_NUMBER_ENABLED` (`1` or `true`, default off). Off or unset: every `/api/v1/stores/:storeId/shared-number*` route and `POST /api/v1/operator/shared-numbers` answers 404, the webhook treats the platform number as an unknown number (200, nothing stored), and queued sends from it are dropped. Ruling ids are in `.superpowers/sdd/2026-10-25-phase8-shared/progress.md`. Nothing here has talked to Meta yet (stubs of the documented shapes only).

## Setup (operator)
`POST /api/v1/operator/shared-numbers` (super admin, session re-checked like every operator write) with `{ phoneNumberId, wabaId, displayPhone?, reason }`:
- one D1 batch writes `shared_numbers`, the number's funding `platform_line` (`fundingStatement`, named explicitly, WA-FUND-1) and a `billing_audit` row `shared_number_registered`. Re-running re-asserts all three. A number a store already owns (`phone_numbers`) is refused with 409.
- The platform number is NOT a `phone_numbers` row: it belongs to no workspace. It sends with `META_SYSTEM_TOKEN` (no `waba_credentials` row, so `graphTokenFor` already answers the platform token).
- Before it sends, the operator also publishes a rate card and FX (see `billing.md`) and registers the number in Meta's console, subscribed to this Worker's webhook.

## Membership
- `GET /stores/:storeId/shared-number` → `{ available, member, displayName, displayPhone }` (any role).
- `POST /stores/:storeId/shared-number/join` `{ displayName? }` (owner). **Package gate**: the store's plan (its own copy of the entitlement) must be `active` or `trialing`, not past its period, and its package must include the shared number (`packages.shared_number = 1`, migration 0012; every existing package, `store-included` among them, defaults to 1). Otherwise `402 package_required` and nothing is written; no plan on record or a package the control plane does not know is refused too (fail closed). `GET /shared-number` carries `packageRequired` (additive) so the page can explain before the owner tries. Re-joining after leaving goes through the same gate. The display name (2-60 characters, default the workspace name) is what customers read in the "which store?" list (cut to 24 characters there). It must differ from every other active member's name as the customer sees it: the comparison runs on the 24-character row text, after folding case, Unicode forms, Arabic diacritics, Arabic/Persian letter variants, Arabic-Indic digits, look-alike letters from Cyrillic and Greek, `0`/`o` and `1`/`l`/`i`, and spacing (`displayNameKey`, unique index in migration 0007). This is deliberately strict: "Ali" and "All" count as the same name: a look-alike is refused with 409 `display_name_taken`, so one store cannot pose as another. The workspace's copy of the funding map is refreshed at once, so the number works now, not after the 30-minute pull.
- `POST /stores/:storeId/shared-number/leave` (owner): status `left`, the store's `shared_routes` rows are deleted, the funding copy drops the number. Queued sends from it are dropped at the consumer: the message is marked `failed` with `error_reason = sender_unavailable` and its wallet hold is released (so it never lingers as `queued` or counts against campaign capacity). The same happens for any send whose number was disconnected or moved.
- `GET /me` → `capabilities.sharedNumber`.
- A store with its OWN active number keeps sending from it (own wins, WA-SHARED-PICK-1); a member without one sends from the platform number (API sends, media upload, wallet estimate, throttle report). Campaigns, catalog and template management stay on own numbers (see "Not done").

## Sending
A member whose plan lapsed (or never included the number) stays a member: inbound routing and replies are untouched, and free-form replies still go out, but a **template send is refused** (`package_required`, not retried, message failed) because a template is how a conversation is started outside the 24 h window. Marketing is gated separately (`plan_blocked`).

Every send through a platform-token number looks the number up in `shared_numbers` (`beforeSharedSend`): not the shared number → untouched; the shared number with the switch off or a non-member → refused, never sent; otherwise `shared_routes(phone_number_id, customer_key, workspace_id, last_at, order_ref)` and `shared_sent(wamid → workspace, customer_key)` are written AFTER Meta accepts the send (`afterSharedSend`; a security fix: a refused or failed send must claim nothing, so the earlier "route before the call" design is superseded). The D1 write is attempted up to 3 times back to back; if all fail it is the alert `shared_sent_not_recorded` (the accepted send is never repeated).
- `customer_key` = HMAC-SHA256(`META_APP_SECRET`, `shared-route:v1:<wa id>`), hex. D1 never holds a raw phone number or message content.
- Store events and one-time codes use the same sender as the inbox (`senderNumberFor`): a shared-only member's COD confirmation, order-created and shipment templates go out on the platform number (with `orderRef`), but one-time codes do NOT: an OTP goes to an arbitrary phone, and sending it on the shared number would claim a shared route for that phone (a cross-store hijack), so OTP for a shared-only store answers `no_number` (it needs its own number). Store events can only target that store's own order customer (the phone comes from the Store's event for that `storeId`, queued by the Store). Cart recovery is marketing and is NEVER sent on the shared number (WA-SHARED-NOCAMP-1): the event is skipped with `shared_number_no_marketing`.
- `order_ref` comes from `SendJob.orderRef` (set for the order-created, COD-confirmation and shipment templates).
- Billing is the existing path: funding `platform_line` → the wallet pays Meta's cost; service replies are charged at the service rate and rebated pro-rata at month close (WA-SHARED-FREE-1, `billing.md`). No funding row → `funding_unknown`, nothing sent (fail closed).
- Templates: see "Platform templates" below. A template that carries the store's name ("on behalf of <store>") is an approved variant created in Meta by the operator; the display name is passed as a template parameter by the caller.

## Platform templates (operator)
The platform WABA's templates are platform-owned: a store cannot list, sync or submit them. The catalog is D1 `shared_templates` (migration `0013_shared_templates.sql`), keyed by WABA because Meta templates belong to the WABA: every shared number on that WABA sees the same row, and a pause blocks all of them (definitions only, no message content). `tightened_at` and the Graph read start are taken from the database clock (`unixepoch('subsec')`), never from an isolate. Super admin routes (switch off or no platform number registered: 404; writes re-check the session like every operator write, fail closed):
- `GET /api/v1/operator/shared-templates` → `{ items }` (name, language, category, status, body text, parameter count, rejection reason).
- `POST /api/v1/operator/shared-templates/sync` → `{ upserted, removed }`: fetches every page from Meta with the PLATFORM token (`META_SYSTEM_TOKEN`) on the shared number's WABA and replaces the catalog in one batch; a failed page changes nothing (503).
- `POST /api/v1/operator/shared-templates` `{ name, language, category: UTILITY|AUTHENTICATION, components }` → submits to Meta with the platform token and stores META'S answer (category and status as Meta returned them, upper-cased; an answer with no category is kept as `UNCONFIRMED`). MARKETING is refused with 400 before Meta.
- The operator console has a "Shared number templates" tab (ar+en) with the same three actions.

Send rule (WA-SHARED-NOCAMP-1, tested): a template goes out from the shared number only if the catalog row, at SEND time, is `APPROVED` and `UTILITY` or `AUTHENTICATION`. A store's own copy of a template decides nothing. The row follows Meta, tightening first: a webhook (`template_category_update`, `message_template_status_update`) that TIGHTENS (rejected, paused, disabled, pending, or a move to marketing) applies at once whatever order it arrives in, and stamps `tightened_at`; a change that would LOOSEN (to approved, or to utility/authentication) is never taken from a webhook: it triggers a fresh Graph read of that template and the row loosens only from that answer, and only if no tightening was recorded after the read began (one clock: ours). Sync and submit use the same rule (upsert; a template Meta no longer lists is disabled, not deleted). A Graph outage leaves the row as tight as it was and logs `shared_template_refresh_failed`. It is checked twice: the inbox API answers `409 template_not_approved`, and the single send chokepoint (`sendToMeta`) refuses with `shared_template_not_allowed` (the message is marked failed, nothing reaches Meta). Own-number sends are untouched. Until the operator has synced, no template can be sent from the shared number (fail closed).

## Inbound routing (`handleSharedEvent`)
Only for the number found in `shared_numbers` while the switch is on. Per message:
1. `candidates` = active members with a route for this customer, newest first.
2. A tap on the list (row id `shared:pick:<workspaceId>`) naming a candidate: sets that route's `chosen_at`, delivers the parked messages to that store, deletes them and the list marker. The tap itself is never stored in a store.
3. `decide()` (pure): with a chosen store, it keeps the replies until ANOTHER store writes after the choice; a store's contact counts for 30 days (`ROUTE_MEMORY_MS`); more than one store within it is ambiguous (the customer chooses), so messaging someone else's customer only earns a place on the list, never a silent takeover. A route is written only after Meta ACCEPTED the store's send (`afterSharedSend`): a refused send claims nothing. A store's message carrying the platform's `shared:pick:` ids is refused before Meta (it could forge the customer's choice).
4. Routed → the message is ingested into that store's Durable Object (normal path: opt-out words, bot, agent, auto reply).
5. Ambiguous → the message is parked in R2 (`shared-parked/<number>/<customer_key>/…`, 48 h) and the customer gets ONE list (`shared-list/…` marker, 24 h, claimed with a conditional put) with store display names only; nothing from any store's conversation goes into it.
6. No route → one generic reply per customer per 24 h (`shared-noroute/…` marker); nothing is stored in any store.
Erasing a contact (`eraseSharedFor`) drops this store's routes (so it is no longer a candidate or offered in the pick list) and removes the sender's parked messages (`shared-parked/<number>/<customer_key>/`) through `r2_pending_deletes` ONLY for a number where this store is the sole candidate; parked messages are shared by every candidate store, so while another store is still a candidate they stay for it (queued before the routes are deleted, retried until R2 confirms).

While the platform number is not green (Meta flagged, rated it red or restricted it) nobody new can join (`409 number_unhealthy`) and `GET /shared-number` says `available: false`; the operator can evict a store (`POST /operator/workspaces/:id/shared-number/evict`) and readmit it. Details: `docs/number-health.md`.

Opt-out (`STOP`, the other opt-out words and a Stop button tap): routed → that store; ambiguous → every active store that wrote to the customer (safe direction), no list, nothing parked; no route → silent, nothing stored.
Statuses (`sent/delivered/read/failed`) are routed by the message id in `shared_sent`; an unknown id is dropped with a warning.
A failing platform send (list, generic reply) that Meta marks retryable fails the webhook (5xx) so Meta redelivers; every step is idempotent on the message id. A permanent failure is logged and dropped.

## Erasure
`WorkspaceDO.eraseContact` also deletes that workspace's `shared_routes` and `shared_sent` rows for the contact (other stores' rows stay). Messages parked for a customer who never chose are not in any store; they expire after 48 h.

## Daily pass
`dailyBilling` runs `sweepShared`: deletes parked messages older than 48 h, list/no-route markers older than 24 h and `shared_sent` rows older than 35 days.

## Alerts (structured logs)
`shared_sent_not_recorded`, `shared_sweep_failed`, `shared_template_refresh_failed`; warnings `shared_status_unknown_message`, `shared_platform_send_failed`, `shared_parked_unreadable`.

## Not done / residual
- Template status webhooks for the platform WABA update the platform catalog only; they are NOT broadcast to members (the names of one store's templates would reach the others). A member still needs the template stored in its own workspace to render it; the platform catalog decides whether it may go out.
- Not verified against real Meta traffic: the `template_category_update` payload field names (see `extractTemplateCategoryUpdates`).
- Campaigns on the shared number are not enabled (one store's broadcast quality would be every store's).
- Not verified against real Meta traffic (list message shape, `recipient_id`-less statuses).
