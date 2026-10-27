# catalog_mass_delete_refused (P1)
**Severity:** P1 look today
## What it means
The nightly Meta catalog reconcile (src/core/store-link/catalog.ts) found that archiving the items Meta has but the Store does not would remove more than 20% of Meta's catalog and more than 10 items. It refused to archive anything this run. Fields: `workspace`, `extras` (items that would be archived), `inCatalog` (items in Meta's catalog).
## Impact
No data was deleted. Updates still go out, but stale items stay in the merchant's WhatsApp catalog until someone decides. Possible causes: wrong catalog id, a half-read Store list, or a real big clean-up.
## Check first
1. Search logs for `{"alert":"catalog_mass_delete_refused"` and read `extras` against `inCatalog`.
2. Confirm the workspace's `catalogId` is the right catalog (docs/store-link.md, "Meta catalog sync").
3. Confirm the Store really removed those products.
## Fix
1. If the catalog id is wrong, the merchant corrects it in settings (PATCH /store-link/settings, owner only).
2. If the clean-up is genuine, the engineer runs `reconcileCatalog({allowMassDelete: true})` on that workspace's Durable Object. No operator route for this was found: ask the engineer on call.
3. If not genuine, do nothing; the refusal repeats nightly while the gap exists.
## Verify it is resolved
The alert stops on the next 03:00 Africa/Cairo reconcile, and `GET /store-link/catalog` shows a fresh `lastSyncAt`.
## Related
docs/store-link.md ("Meta catalog sync"), alert: catalog_business_mismatch
