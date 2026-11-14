# Ruling WA-CAT-3

**Decision:** Once a catalogue is verified on the workspace's WABA, the shop button (`is_catalog_visible`) and the cart (`is_cart_enabled`) are switched on automatically on every active number of that WABA (`POST /{phone_number_id}/whatsapp_commerce_settings`), at the start of each full pass and when it is stale (24 h). The merchant can turn either off from the Bot screen; that choice is stored (`catalog.commerce_want`) and the automatic pass honours it.

**Evidence (2026-11-14):** Meta's default is catalogue button hidden and cart on (set-commerce-settings page), so a connected catalogue shows nothing in the profile until this call is made. The endpoint takes the settings as query parameters and answers `{ success: true }`; GET answers `{ data: [{ is_cart_enabled, is_catalog_visible }] }`. Tests: `test/catalogue-store.test.ts` (the shop button and the cart on the number).

**Cost if wrong:** If Meta rejects the call (permission), the status shows `commerce.failed` and `catalog_permission_missing` alerts; the catalogue still syncs and cards still work, only the profile button stays hidden. If a merchant wanted the button hidden and never said so, it appears: one tap to turn off.
