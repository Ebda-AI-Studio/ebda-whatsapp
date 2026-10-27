# catalog_business_mismatch (P1)
**Severity:** P1 look today
## What it means
While creating a WhatsApp catalog for a merchant (src/core/store-link/catalog-provision.ts), Meta, asked with the merchant's own token, said the stored business portfolio id does not own this WABA. The only field is `workspace`.
## Impact
Nothing was created and the pending provision record was cleared. The merchant sees a `business_mismatch` (409) error and has no catalog. Money and consent are not affected. It can mean a stale or wrong business id stored at connect.
## Check first
1. Search logs for `{"alert":"catalog_business_mismatch"` and note the workspace.
2. Read docs/store-link.md, "Creating the catalog for a merchant who has none", step 2.
3. The business id is stored in D1 `waba_credentials.business_id` (read only).
## Fix
1. Ask the merchant to reconnect their number through Embedded Signup so the right business id is stored, then retry "Create my WhatsApp catalog".
2. The system does not repair this itself. Do not edit credentials by hand.
## Verify it is resolved
The merchant's retry of `POST /stores/:storeId/store-link/catalog/provision` returns a `catalogId` and no new alert appears.
## Related
docs/store-link.md ("Creating the catalog for a merchant who has none"), alert: catalog_mass_delete_refused
