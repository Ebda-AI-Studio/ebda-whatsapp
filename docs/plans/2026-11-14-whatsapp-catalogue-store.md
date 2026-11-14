# WhatsApp catalogue as a store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are TDD (test first, watch it fail).

**Goal (Ahmad 2026-11-14):** the merchant's Ebda Store products appear in WhatsApp as a real store: the shop button on the business profile, product cards the AI agent sends in chat, and a cart sent from the catalogue that becomes a real Ebda Store order. The old Store-side native catalog bot (dropped 2026-11-03) is the intent.

## Finish line (four lines)
1. **Must work:** every product, price, stock, image and delete in the Store reaches the WhatsApp-linked Meta catalogue (any size, variants as `item_group_id` groups); the number shows the catalogue button and the cart; the agent sends product / multi-product / catalogue messages; a cart becomes one Store order.
2. **Exercised:** Meta Graph mocked at the HTTP boundary with response shapes from the official docs; the Store bridge through `FakeStore` (now obeying the real bridge's id semantics); the real webhook route for the `order` message; the merchant status API + Bot screen.
3. **Must NOT change:** the catalogue-id verification (`verifiedAuth`), the mass-delete refusal, provisioning, the ordering bot's COD / link / InstaPay flows, one writer per order (the Store), prices and stock always read live.
4. **Done =** `npm test` exit 0, `npm run typecheck` exit 0, `npm audit` 0, every link below proven by a named test, and the list in "What needs a real Meta account" is the only unverified residue.

## Meta API shapes used (verified against the official docs, 2026-11-14)
| Call | Shape | Source |
|---|---|---|
| Batch | `POST /{catalog_id}/items_batch` `{ item_type: 'PRODUCT_ITEM', allow_upsert, requests: [{ method: CREATE\|UPDATE\|DELETE, data: { id, ... } }] }`, up to 5000 records; the answer is `{ handles: [handle] }` (ingestion is ASYNCHRONOUS). DELETE carries only `id`. | developers.facebook.com/documentation/ads-commerce/marketing-api/reference/product-catalog/items_batch |
| Batch result | `GET /{catalog_id}/check_batch_request_status?handle=…[&load_ids_of_invalid_requests=true]` → `{ data: [{ handle, status, warnings:[{line,id,message}], errors_total_count, ids_of_invalid_requests }] }`; status `finished` is the only documented value. | …/product-catalog/check_batch_request_status |
| Commerce settings | `POST /{phone_number_id}/whatsapp_commerce_settings?is_catalog_visible=true&is_cart_enabled=true` → `{ success: true }`; `GET` → `{ data: [{ is_cart_enabled, is_catalog_visible, id }] }`. Defaults: cart true, catalogue visible FALSE. | …/whatsapp/catalogs/set-commerce-settings |
| Single product | `interactive: { type: 'product', body?, footer?, action: { catalog_id, product_retailer_id } }` | …/catalogs/single-product-messages |
| Multi product | `interactive: { type: 'product_list', header: { type: 'text', text }, body, footer?, action: { catalog_id, sections: [{ title, product_items: [{ product_retailer_id }] }] } }`; up to 30 products; unmatched items are dropped, none matching = error and no send. 10 sections and 24-char section titles are the long-standing client limits (not restated on the current page; enforced anyway). | …/catalogs/multi-product-messages |
| Catalogue | `interactive: { type: 'catalog_message', body (≤1024), footer? (≤60), action: { name: 'catalog_message', parameters?: { thumbnail_product_retailer_id } } }`; needs a catalogue connected to the WABA hierarchy. | …/catalogs/catalog-messages |
| Order webhook | `messages[].type = 'order'`, `order: { catalog_id, text, product_items: [{ product_retailer_id, quantity, item_price, currency }] }` | …/webhooks/reference/messages/order |
| Connect | `POST /{waba_id}/product_catalogs { catalog_id }`; one catalogue per WABA hierarchy. | upload-inventory page + existing `connectCatalogToWaba` |

## Audit: the chain, measured on origin/main
| # | Link | Evidence (file:line, test) | Was | Now |
|---|---|---|---|---|
| 1 | Provision catalogue | `src/core/store-link/catalog-provision.ts` ; `test/catalog-provision.test.ts` "creates the catalog, connects it to the WABA…" | works (mocked; real Meta unverified) | unchanged |
| 2 | Connect to WABA | `catalog-api.ts connectCatalogToWaba`; same test file | works (mocked) | unchanged |
| 3 | Commerce settings (`is_catalog_visible`, `is_cart_enabled`) | `grep whatsapp_commerce_settings src` = nothing | **MISSING**: without it the shop button never shows (Meta default is hidden) | `catalog-api.ts` get/set, applied automatically after connect, merchant toggle, status shows it |
| 4 | Initial sync | `catalog.ts runCatalogReconcile`, whole store read in ONE run (up to 200 pages) | works for small stores; one long run is a subrequest-limit risk for large ones; no cursor | resumable passes (cursor + pass id in state), 3 pages per run |
| 5 | Incremental sync (events) | `catalog.ts runCatalogSync`; test "pushes a changed product…" | **BROKEN for variants**: asks `getProducts([productId])`, and the Store's `catalogByIds` filters variant rows by the ids given (`ebda-store apps/api/src/lib/wa/bridge/do-port.ts catalogByIds/rowsForProducts`), so a product WITH variants returns zero rows and nothing is sent until the nightly run | asks `[productId, ...variantIds]`; FakeStore obeys the real semantics |
| 6 | Deletes archive | `runCatalogSync` deletes only `event.variantIds`; the Store sends `variantIds: []` for a deleted product (`wa-store-events.ts catalogEvents`: `row?.variants.map(…) ?? []`) | **BROKEN**: a deleted product (and every simple product, whose retailer id is the product id) is not removed until the nightly diff | `catalog_items` ledger: delete removes everything the ledger knows for the product; a variant removed from a live product is removed too |
| 7 | Variants | `toFeedItem` has no `item_group_id` | one flat item per variant, no grouping | `item_group_id = productId` for variant rows |
| 8 | Images | `toFeedItem` returns null; `skipped++` in a log line | silent drop (count in a log only) | reason recorded in `catalog_items`, listed in status, `catalog_items_rejected` info alert |
| 9 | Batch result | `itemsBatch` reads `validation_status` of the immediate answer | Meta's batch is async (handle); item errors would never be seen | handles kept, `check_batch_request_status` read on the next run, rejected ids recorded + alerted |
| 10 | Arabic title | `toFeedItem(r, preferArabic)`; test "pushes a changed product" (`Item 3 (ع)`) | works | unchanged |
| 11 | Price/stock within minutes | events set `catalog_dirty` + 30 s debounce (`events.ts`) ; test "coalesces a burst…" | works | + propagation test through the variant path |
| 12 | Agent search | `ai/tools.ts search_catalog` returns text hits | works (text only) | + `show_products` / `open_catalog` tools |
| 12b | Agent index search | `ai/tools.ts searchCatalog` passed vector-index PRODUCT ids to `getProducts`, which answers only to retailer ids: for a product with variants it returned nothing and the code silently fell back to walking the whole catalogue (`test/agent-kb.test.ts` "turning the agent on indexes the catalog…" caught it once FakeStore obeyed the real contract) | **latent bug** | the ledger maps product ids to retailer ids first |
| 13 | Product cards | `grep product_list\|'product'\|catalog_message src` = nothing | **MISSING** | `meta/client.ts` senders, `send-queue` kinds, `store-link/product-cards.ts` builders with the limits |
| 14 | Cart webhook parse | `webhook-schema.ts:19-124`; `test/bot-funnel-flow.test.ts` "a cart sent from Meta's catalog counts as a cart" | works | unchanged |
| 15 | Cart → live validation | `bot.ts receiveCart` takes Meta's price as the line price, title = retailer id, no stock or existence check before the customer picks payment | **WEAK**: shows an unknown id as a product name and a stale price; failure only at order creation | re-read live rows, live prices, drops unknown ids, tells the customer what is sold out or changed |
| 16 | Order creation | `bot.ts placeOrder` → `createOrderFromChat`, key `bot:{ws}:{orderKey}`; tests in `test/ordering.test.ts` | works | + deterministic key for a cart (one webhook, one order) |
| 17 | Merchant status | `GET /store-link/catalog` = `{catalogId,lastSyncAt}` | minimal | items synced/excluded (+why), commerce flags, last error, resync + commerce actions, Bot-screen section |

## Ruling summary (full text in `docs/rulings/WA-CAT-*.md`)
- **WA-CAT-1** the catalogue retailer id is `CatalogRow.retailerId` verbatim (the Store's canonical feed id); this repo never derives an id.
- **WA-CAT-2** one source per WhatsApp-linked catalogue: Ebda Chat's Batch API sync. A second Meta data feed (the Google-format URL) on the same catalogue would duplicate or fight it.
- **WA-CAT-3** the shop button and cart are switched on automatically once the catalogue is verified on the WABA; the merchant can turn them off.
- **WA-CAT-4** a cart's prices are never trusted; the live Store row decides price, stock and existence.

## Tasks
1. Contract + FakeStore real semantics; Meta API (check status, commerce settings).
2. `catalog_items` ledger migration; sync/reconcile rewrite (variants, deletes, exclusions, resumable passes, batch results).
3. Product-message senders, job kinds, builders (30 items / 10 sections), copy.
4. Agent tools and send path; fallback to text with links.
5. Cart → live validation, deterministic key.
6. Status API, resync and commerce actions, Bot-screen section, alerts + runbooks, docs.

## What needs a real Meta account to verify
Real catalogue creation permissions, `whatsapp_commerce_settings` on a live number, the exact async batch error payloads, product cards rendering on a handset, and a real cart from a phone. Every one of these is mocked from the documented shapes only.
