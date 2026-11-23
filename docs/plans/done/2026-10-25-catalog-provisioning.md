# Meta catalog provisioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are TDD (test first, watch it fail).

**Goal:** a merchant with no Meta product catalog gets one created and connected to their WhatsApp Business Account from the Bot/Store settings, so the existing catalog sync (`docs/store-link.md` § Meta catalog sync) works without them visiting Meta's Commerce Manager.

**Spec:** coordinator ruling 2026-10-25 item (5): "create the catalog for merchants without one, via Embedded Signup permissions". Today the merchant must paste an existing `catalogId`, verified against `GET /{waba}/product_catalogs`.

## Global constraints
- Repo rules in `CLAUDE.md`; envelope `src/core/api/store-events.ts` frozen.
- Graph calls go through the existing Meta client and the per-WABA business token (`graphTokenFor`); never the platform token for a merchant's assets. Graph version from `META_GRAPH_VERSION`.
- Read Meta's current docs before coding (WebFetch developers.facebook.com): the catalog create edge (`POST /{business_id}/owned_product_catalogs`, fields `name`, `vertical=commerce`), the WABA connect edge (`POST /{waba_id}/product_catalogs` with `catalog_id`), the permission each needs (`catalog_management`, `business_management`, `whatsapp_business_management`), and whether the Embedded Signup business token carries them. Record what you found, with URLs, in the ledger. If a permission is missing from our Embedded Signup configuration, the feature must say so plainly (a clear "reconnect to grant catalog access" state), not fail silently; add the permission to `docs/launch/README.md` §2 (App Review list).
- Idempotent: a retried provision never creates two catalogs (store a pending provision record with an idempotency key before calling Meta; on retry, look the catalog up by name/id first).

## Task 1 — provision
`provisionCatalog(host, { name })` in `src/core/store-link/catalog.ts` (or a new `catalog-provision.ts`): needs the workspace's business id (from Embedded Signup's `businessId`, stored at connect time; if absent, fetch `GET /{waba_id}?fields=owner_business_info`), creates the catalog, connects it to the WABA, saves `catalogId` through the same verified path the PATCH uses, then schedules the first full sync. Route `POST /api/v1/stores/:storeId/store-link/catalog/provision` (owner only, Zod `{ name? }` defaulting to the store name). Errors map to clear codes: `missing_permission`, `no_business`, `meta_error` (retryable or not).

## Task 2 — UI + docs
Bot/Store settings: when no catalog is set, a "Create my WhatsApp catalog" action with progress and the error states above (ar/en); when set, show the catalog id and the last sync. Docs: `docs/store-link.md` (provisioning), help guide 11 or a short new section, launch README permission line.

## Tests
Graph stubbed (stubGraph): success path (create → connect → saved → sync scheduled), retry after a timeout between create and connect creates no second catalog, missing permission → `missing_permission` with nothing saved, staff 403, a catalog already set → 409.
