# catalog_sync_stuck (P1)
**Severity:** P1 look today
## What it means
The WhatsApp catalogue sync (src/core/store-link/catalog.ts) failed three runs in a row, then every tenth run after. Fields: `workspace`, `failures`, `code` (Meta's error code, null for a Store or network failure).
## Impact
New products, prices and stock changes are not reaching the merchant's WhatsApp catalogue; the shop and the product cards show stale data. The sync keeps retrying with backoff and nothing is lost.
## Check first
1. Search logs for `catalog items_batch` / `catalog read from the Store failed` for the workspace.
2. `GET /store-link/catalog` shows `error` (`sync_failed` or `missing_permission`).
3. Check Meta status and the Store bridge (`getProducts`, `listCatalog`).
## Fix
1. Store failure: fix the Store, the next retry succeeds.
2. Meta rejected the batch: read the message in the log; a bad item is fixed in the Store.
3. Permission code: see catalog_permission_missing.
## Verify it is resolved
The counter clears on the next successful run; `GET /store-link/catalog` shows `error: null` and a fresh `lastSyncAt`.
## Related
docs/store-link.md ("WhatsApp catalogue"), alert: catalog_mass_delete_refused
