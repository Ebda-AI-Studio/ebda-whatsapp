# Ruling WA-CAT-1

**Decision:** The retailer id of every item in the WhatsApp-linked Meta catalogue is `CatalogRow.retailerId` exactly as the Store's bridge returns it (the Store's canonical feed item id). This repo never derives, prefixes or rewrites an id. Variants are one item each, joined by `item_group_id = productId` (a row whose retailer id differs from its product id).

**Evidence (2026-11-14):** `ebda-store apps/api/src/lib/wa/bridge/do-port.ts rowsForProducts` sets retailerId = variant id (or the product id of a simple product). At the time of writing no open PR from `feat/catalogue-feeds` existed on ebda-store, so this code reads `retailerId` as the single source; when the canonical feed-id function lands the bridge's `listCatalog`/`getProducts` return it unchanged and nothing here moves. Tests: `test/catalogue-store.test.ts` (variants, group id), `test/catalogue-chat.test.ts` (cards and cart use the same id).

**Cost if wrong:** If the Store's canonical feed id and the bridge's `retailerId` ever differ, product cards and carts would reference ids Meta does not hold (cards refused, carts unknown). The Store-side PR must change `retailerId` in the bridge in the same release, or ids already in Meta would be archived and re-created by the next full pass (a gap of minutes, no data loss).
