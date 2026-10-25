# Store link (Phase 4)

Ebda WhatsApp talks to the Ebda Store through the integration contract (`business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md`, with the 2026-10-25 InstaPay/OTP addendum). **The Store owns orders, stock, prices and payment state; this service never writes them, it asks.** The Store side does not exist yet, so everything is built against the `StoreBridge` interface and a contract-faithful fake (`test/helpers/fake-store.ts`).

## Switching it on
The link is inert until the Store is bound. Nothing below is live in `wrangler.jsonc` (a binding to something undeployed breaks the deploy); the commented block there lists what to add once the Store Worker and the two queues exist:

| Needed | Where | Effect while missing |
|---|---|---|
| Service Binding `STORE_BRIDGE` -> Store API Worker, entrypoint `WhatsAppBridge` | wrangler `services` | `/me.capabilities.codOutcome=false`, orders route answers a labelled sample, ordering bot silent, generic auto reply stays |
| Queue consumer `ebda-wa-events` (DLQ `ebda-wa-events-dlq`) | wrangler `queues.consumers` | Store events are never delivered |
| Queue producer `STORE_EVENTS` -> `ebda-store-events` | wrangler `queues.producers` | outcomes reach the Store over the bridge only |
| Secret `PROOF_URL_SECRET`, var `PUBLIC_BASE_URL` | wrangler secret / vars | InstaPay receipts cannot be forwarded: the turn alerts `proof_url_not_configured` and retries |
| `SUITE_BUYER_KEY_SECRET` (already used by erasure) | wrangler secret | customer key cannot be computed: orders route 503, bot says the Store is unavailable |
| `CI_OUTCOMES` Analytics dataset `ebda_ci_outcomes` | wrangler (live) | none; best effort |

Wiring lives in `src/index.ts` (`configureStoreLink`): the core never imports an addon; the addon supplies the bridge adapter (`src/addons/ebda/store-bridge.ts`), the queue sink (`store-events.ts`) and all customer copy (`store-copy.ts`, Egyptian Arabic + English). Tests register fakes the same way.

## What the Store must answer (the shape we built against)
Every `WhatsAppBridge` method takes `storeId` first and returns `{ ok: true, value } | { ok: false, reason, message?, outOfStock? }` with `reason` one of `not_found | not_linked | out_of_stock | payment_method_disabled | invalid | unavailable`. The adapter validates every answer with Zod (`src/core/store-bridge.ts` has the schemas); a throw, an 8 s timeout or a malformed answer becomes `unavailable`.

`getStoreProfile` (name, logo, locale ar|en, currency, `paymentMethods` subset of cod|link|instapay, `codEnabled`, `instapay {ipa, displayName}`), `listCatalog(cursor, limit<=100)` and `getProducts(productIds[])` (rows: retailerId = variant id, productId, title, titleAr, priceMinor, availability, imageUrl, link ...), `createCheckoutLink`, `createOrderFromChat` (`paymentMethod` cod|link|instapay, idempotency key required; returns `orderId, orderNumber, totalMinor?, currency?, paymentUrl?, instapay? {ipa, amountMinor, reference}`; an InstaPay order is `pending_payment`), `getPaymentLink`, `recordCodOutcome` (idempotent on `idempotencyKey`), `attachPaymentProof(orderId, mediaUrl)`, `getCustomerAddresses` / `saveCustomerAddress`, `getOrderStatus`, `listCustomerOrders(buyerKey, limit)` (summaries carry `orderId`).

Two additions the contract's "minimum" lacks, used when present and looked up (`listCustomerOrders`) when not: `order.cod_confirmation_requested` should carry `orderNumber`, `totalMinor`, `currency`; `shipment.updated` may carry `phoneE164`, `orderNumber`, `locale`.

## Events in (`ebda-wa-events`)
Schemas: `src/core/api/store-events.ts` (envelope `{id, type, v:1, storeId, occurredAt, data}`; the file is pinned by sha256 in `test/guards.test.ts`, the Store repo must carry a byte-identical copy). The consumer (`src/core/store-events.ts`) acks malformed/unknown/future-version bodies, retries unregistered workspaces and thrown errors. The workspace (`applyStoreEvent`) dedupes on the envelope id (`processed_events`, 14 days), drops an older version of an entity (`entity_versions`), and writes state + message row + the `send_release` task + the dedupe marker in ONE transaction.

| Event | Effect |
|---|---|
| `store.plan_changed` / `linked` / `unlinked` | `store_state`; unlinked stops every customer-facing effect (not data-protection) |
| `catalog.product_upserted/deleted` | `catalog_dirty` + one debounced (30 s) `catalog_sync` task |
| `order.created` | order row; confirmation template unless COD, or placed in this chat, or `orderConfirmations` is off |
| `order.cod_confirmation_requested` | COD template with Confirm/Refuse quick replies (payload `cod:y|n:<orderId>`), tag `cod_pending`, order row `cod_state=pending`, 24 h `cod_no_reply` task; one request per order however many envelopes |
| `order.status_changed` | status; any cancel/refund closes the COD state; `paid` tells an InstaPay/link customer inside the window |
| `shipment.updated` | tracking template (with URL) or status template; only announced statuses, once per shipment+status |
| `cart.abandoned` | marketing template, never on the shared platform number (skipped `shared_number_no_marketing`); needs a recorded opt-in and no opt-out, a plan that is not past due, and (on a platform-paid number) wallet funds; see `docs/billing.md` |
| `customer.erased` | deletes the customer's contact, messages, orders, bot session; **never gated by link state; recorded as processed only after the erase succeeded** |

## COD confirmation and outcomes
A customer's tap (or the merchant in the inbox: `POST /contacts/:waId/orders/:orderNumber/cod-outcome`, owner or staff) goes through one function, `resolveCod`: only cash-on-delivery orders, only of that customer (exact `wa_id`), only while the order is not over; first answer wins, the same answer is idempotent, the opposite is 409; a real answer may replace `no_reply`. Recording is local and atomic; telling the Store is a retried task (`cod_outcome_push`): RPC `recordCodOutcome` then a `whatsapp.cod_outcome` event on `ebda-store-events`, both under one idempotency key. One Analytics Engine point per recorded outcome in `ebda_ci_outcomes`: `indexes [storeId]`, `blobs [buyerKey, storeId, outcome, orderId, 'whatsapp']`, `doubles [at]`; never a phone number.

## Meta catalog sync
Merchant sets `catalogId` (PATCH `/store-link/settings`, owner only). **A catalog id is a capability on the platform token**, so it is accepted only if `GET /{waba}/product_catalogs` for this workspace's WABA lists it, and is re-verified before every sync and reconcile (the workspace must still own an active number on that WABA). Event sync pushes the changed products (`items_batch`, `allow_upsert`; HTTP 200 validation errors count as failures); the nightly reconcile (03:00 Africa/Cairo) re-sends everything and archives what only Meta has, but refuses to archive more than 20% of Meta's catalog (and more than 10 items) in one run (`catalog_mass_delete_refused`; operator: `reconcileCatalog({allowMassDelete: true})`) and never archives anything on an empty Store answer.

## Ordering in chat (`src/core/ordering/bot.ts`)
Ported logic of the old bot (state machine rules, not code). States `idle, browsing, choosing_qty, cart, choosing_payment, choosing_address, awaiting_address, awaiting_proof`; no terminal state; restart words (`طلب جديد`, `new order`, `menu` ...) work anywhere. Browse = an image per product then one list (9 products + `more:<cursor>`; pagination lives in the row id). Quick replies by button; a typed number works too. A cart sent from Meta's catalog replaces the cart; the Store re-prices the order. Payment (only the methods the store enabled): COD, payment link (order's `paymentUrl`, else `getPaymentLink`, else `createCheckoutLink`), InstaPay (IPA, amount, reference sent; order stays `pending_payment`; a picture within 48 h is forwarded once with `attachPaymentProof` via a signed, expiring, private link `GET /api/v1/proof/:ws/:messageId?exp&sig`). Stock refusal names the item and removes it. Replies go out directly from the workspace, 150 ms apart, inside the 24 h window only; a turn is replayable (deterministic keys, session saved last, one order attempt key). The generic auto reply is suppressed while the bot is active. `bot_turn` is a scheduler task per inbound message.

## OTP over WhatsApp (OTP-1)
`WhatsAppOtp.sendOtp(storeId, phone, code)` (internal RPC entrypoint, no UI). Off until `otpViaWhatsApp` is switched on; email stays the main channel. Results are objects: `ok`, or `disabled | invalid | country_not_allowed | not_found | no_number | template_unavailable | rate_limited | send_failed | unavailable` (anything but `ok` = fall back to email).
- Only an `AUTHENTICATION` template may carry a code (a UTILITY-synced one is refused); the stored text, search index and realtime events hold `••••••` whatever the template.
- Sent at once or not at all: over the tier/throughput limit, on Meta's 131049, or on any Meta failure (even a retryable one) the message is marked `failed` and the Store falls back. No scheduler row and no queue retry ever holds a code.
- Toll-fraud bounds (policy `configureStoreLink({ otp })`, core default and `src/addons/ebda/otp-policy.ts`): Egypt (+20) only, 5 per phone and 30 per workspace per 10 minutes, counted (failed attempts included) in the same transaction that stores the message.

## Settings
`GET|PATCH /stores/:storeId/store-link/settings`: `orderConfirmations` (default on), `orderingBot` (default on), `otpViaWhatsApp` (default off), `catalogId`. Contract additions for the UI (all additive): `orderSummaryDto.paymentMethod` accepts `instapay`; `GET /me` returns `capabilities { codOutcome }`; `codOutcomeResponse`, `meResponse`, `storeLinkSettings*` schemas.

## DO migrations added
v13 `processed_events`, `entity_versions`, `store_state`, `contacts.buyer_key`, `store_orders`, `catalog_dirty` · v14 `store_orders.locale` · v15 `bot_sessions`. Backed up: `store_orders`, `store_state`.

## Scheduler kinds added
`catalog_sync` (singleton, debounce), `catalog_reconcile` (singleton, nightly), `cod_no_reply`, `cod_outcome_push`, `bot_turn`.

## Not done / needs the other side
Native Meta `catalog_message`/`product_list` sends; the Store's real RPC and queues; `PUBLIC_BASE_URL`/`PROOF_URL_SECRET` values; wallet checks (done in Phase 7, `docs/billing.md`). The AI agent and its handoff words are in `docs/ai-agent.md`.
