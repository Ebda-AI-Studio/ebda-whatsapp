# catalog_permission_missing (P1)
**Severity:** P1 look today
## What it means
Meta answered a catalogue call with a permission or token error (codes 10, 190, 200). Fields: `workspace`, `code`, optional `step` (commerce_settings).
## Impact
The merchant's WhatsApp catalogue cannot be updated and the shop button cannot be switched on until catalogue access is granted again.
## Check first
1. `GET /store-link/catalog` shows `error: missing_permission`.
2. Ask whether the merchant disconnected the number or removed the business permission (catalog_management, whatsapp_business_management).
## Fix
1. The merchant reconnects the number from the WhatsApp number screen and approves the catalogue permission.
2. Then presses Resync now on the Bot screen.
## Verify it is resolved
The next sync succeeds, `error` is null and `commerce.failed` is null.
## Related
docs/store-link.md ("WhatsApp catalogue"), alert: catalog_mass_delete_refused
