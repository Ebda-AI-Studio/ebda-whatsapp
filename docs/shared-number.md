# The shared platform number (Phase 8.2)

Backend only. Switch: `SHARED_NUMBER_ENABLED` (`1` or `true`, default off). Off or unset: every `/api/v1/stores/:storeId/shared-number*` route and `POST /api/v1/operator/shared-numbers` answers 404, the webhook treats the platform number as an unknown number (200, nothing stored), and queued sends from it are dropped. Ruling ids are in `.superpowers/sdd/2026-10-25-phase8-shared/progress.md`. Nothing here has talked to Meta yet (stubs of the documented shapes only).

## Setup (operator)
`POST /api/v1/operator/shared-numbers` (super admin, session re-checked like every operator write) with `{ phoneNumberId, wabaId, displayPhone?, reason }`:
- one D1 batch writes `shared_numbers`, the number's funding `platform_line` (`fundingStatement`, named explicitly, WA-FUND-1) and a `billing_audit` row `shared_number_registered`. Re-running re-asserts all three. A number a store already owns (`phone_numbers`) is refused with 409.
- The platform number is NOT a `phone_numbers` row: it belongs to no workspace. It sends with `META_SYSTEM_TOKEN` (no `waba_credentials` row, so `graphTokenFor` already answers the platform token).
- Before it sends, the operator also publishes a rate card and FX (see `billing.md`) and registers the number in Meta's console, subscribed to this Worker's webhook.

## Membership
- `GET /stores/:storeId/shared-number` → `{ available, member, displayName, displayPhone }` (any role).
- `POST /stores/:storeId/shared-number/join` `{ displayName? }` (owner). The display name (2-60 characters, default the workspace name) is what customers read in the "which store?" list (cut to 24 characters there). It must differ from every other active member's name after folding case, Unicode forms, Arabic diacritics, letter variants and spacing (`displayNameKey`, unique index in migration 0007): a look-alike is refused with 409 `display_name_taken`, so one store cannot pose as another. The workspace's copy of the funding map is refreshed at once, so the number works now, not after the 30-minute pull.
- `POST /stores/:storeId/shared-number/leave` (owner): status `left`, the store's `shared_routes` rows are deleted, the funding copy drops the number. Queued sends from it are dropped at the consumer.
- `GET /me` → `capabilities.sharedNumber`.
- A store with its OWN active number keeps sending from it (own wins, WA-SHARED-PICK-1); a member without one sends from the platform number (API sends, media upload, wallet estimate, throttle report). Campaigns, catalog and template management stay on own numbers (see "Not done").

## Sending
Every send through a platform-token number looks the number up in `shared_numbers` (`beforeSharedSend`): not the shared number → untouched; the shared number with the switch off or a non-member → refused, never sent; otherwise `shared_routes(phone_number_id, customer_key, workspace_id, last_at, order_ref)` is upserted BEFORE the call (a reply can never beat the route) and, once Meta accepts, `shared_sent(wamid → workspace, customer_key)` is written. A failure to write `shared_sent` is the alert `shared_sent_not_recorded` (the accepted send is never retried).
- `customer_key` = HMAC-SHA256(`META_APP_SECRET`, `shared-route:v1:<wa id>`), hex. D1 never holds a raw phone number or message content.
- `order_ref` comes from `SendJob.orderRef` (set for the order-created, COD-confirmation and shipment templates).
- Billing is the existing path: funding `platform_line` → the wallet pays Meta's cost; service replies are charged at the service rate and rebated pro-rata at month close (WA-SHARED-FREE-1, `billing.md`). No funding row → `funding_unknown`, nothing sent (fail closed).
- Templates: the platform WABA's templates are shared infrastructure. A template that carries the store's name ("on behalf of <store>") is an approved variant created in Meta by the operator/merchant; the display name is passed as a template parameter by the caller. This code does not create or approve templates.

## Inbound routing (`handleSharedEvent`)
Only for the number found in `shared_numbers` while the switch is on. Per message:
1. `candidates` = active members with a route for this customer, newest first.
2. A tap on the list (row id `shared:pick:<workspaceId>`) naming a candidate: sets that route's `chosen_at`, delivers the parked messages to that store, deletes them and the list marker. The tap itself is never stored in a store.
3. `decide()` (pure): with a chosen store, it keeps the replies until ANOTHER store writes after the choice; a store's contact counts for 30 days (`ROUTE_MEMORY_MS`); more than one store within it is ambiguous (the customer chooses), so messaging someone else's customer only earns a place on the list, never a silent takeover. A route is written only after Meta ACCEPTED the store's send (`afterSharedSend`): a refused send claims nothing. A store's message carrying the platform's `shared:pick:` ids is refused before Meta (it could forge the customer's choice).
4. Routed → the message is ingested into that store's Durable Object (normal path: opt-out words, bot, agent, auto reply).
5. Ambiguous → the message is parked in R2 (`shared-parked/<number>/<customer_key>/…`, 48 h) and the customer gets ONE list (`shared-list/…` marker, 24 h, claimed with a conditional put) with store display names only; nothing from any store's conversation goes into it.
6. No route → one generic reply per customer per 24 h (`shared-noroute/…` marker); nothing is stored in any store.
Opt-out (`STOP` and the other opt-out words): routed → that store; ambiguous → every active store that wrote to the customer (safe direction), no list, nothing parked; no route → silent, nothing stored.
Statuses (`sent/delivered/read/failed`) are routed by the message id in `shared_sent`; an unknown id is dropped with a warning.
A failing platform send (list, generic reply) that Meta marks retryable fails the webhook (5xx) so Meta redelivers; every step is idempotent on the message id. A permanent failure is logged and dropped.

## Erasure
`WorkspaceDO.eraseContact` also deletes that workspace's `shared_routes` and `shared_sent` rows for the contact (other stores' rows stay). Messages parked for a customer who never chose are not in any store; they expire after 48 h.

## Daily pass
`dailyBilling` runs `sweepShared`: deletes parked messages older than 48 h, list/no-route markers older than 24 h and `shared_sent` rows older than 35 days.

## Alerts (structured logs)
`shared_sent_not_recorded`, `shared_sweep_failed`; warnings `shared_status_unknown_message`, `shared_platform_send_failed`, `shared_parked_unreadable`.

## Not done / residual
- Per-store templates on the platform WABA: template status webhooks are NOT broadcast to members (the names of one store's templates would reach the others) and members cannot sync templates from it. Until the operator provisions approved variants into a member's workspace, a member can answer inside the 24-hour window and send only templates already stored for it.
- Campaigns on the shared number are not enabled (one store's broadcast quality would be every store's).
- Not verified against real Meta traffic (list message shape, `recipient_id`-less statuses).
