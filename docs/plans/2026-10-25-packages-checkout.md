# Packages: entitlement writers and self-serve checkout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are TDD (test first, watch it fail).

**Goal:** every workspace gets its package record from a real writer (the Store plan, an operator, or a purchase), the Store learns about it, and merchants can buy a package themselves.

**Architecture:** D1 `workspace_subscriptions` stays the only source; every writer goes through ONE function that bumps `version`, writes the row, pushes `applyEntitlement` to the workspace Durable Object (existing `pushEntitlement`) and queues `whatsapp.entitlement_changed` for the Store. Checkout reuses the Kashier top-up machinery (`src/core/billing/topups.ts`, `payments.ts`): same signed-webhook path, a second order kind.

**Spec:** the accepted Store↔WhatsApp contract (`~/Desktop/projects/Ebda-AI-Studio/business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md` §Plans) and the coordinator rulings of 2026-10-25 (Store register): 2(a), 3(b), 4(c), 5.

## Global constraints
- Repo rules in `CLAUDE.md` (no legacy strings, `src/core` names no brand, Zod at every edge, no raw phones in logs).
- Money bar: amounts computed server-side only from `packages.price_minor`; webhook HMAC verified over the raw body; idempotent on the provider order id; replay-safe; a purchase never grants twice; fail closed.
- Envelope is FROZEN at sha256 `df57a0f0…a5b4ec` (commit 1cfb45b): use `whatsapp.entitlement_changed` and the optional `status`/`periodEnd` on `store.plan_changed` exactly as defined; never edit `src/core/api/store-events.ts`.
- Switch: `PACKAGE_CHECKOUT_ENABLED` ("true"), default off; the routes answer 404 while off.

## Task 1 — one writer: `setSubscription`
`src/core/billing/subscriptions.ts`: `setSubscription(env, { workspaceId, packageId, status, periodStart, periodEnd, source: 'store_plan' | 'operator' | 'purchase', ref }) → { version, applied }`. In one D1 batch: upsert the row with `version = version + 1` and write a `billing_audit` row (source, ref). Then `pushEntitlement`, then queue `whatsapp.entitlement_changed { packageId, automation: status in (trialing, active), status, validUntil: periodEnd, version }` through the existing outbound Store events path. Tests: version strictly increases; the Store event carries it; a failed DO push is repaired by the daily reconcile (existing).

## Task 2 — Store plan → "store-included" package (ruling 2a)
`src/core/store-link/events.ts` `store.plan_changed`: idempotent on event id (existing dedupe), ignores an event whose `effectiveAt` is older than the last applied one. `includesWhatsApp=true` → `setSubscription(package 'store-included', status = data.status ?? 'active', periodEnd = data.periodEnd ?? effectiveAt + 31 days, source 'store_plan')`. `false` → cancel the store-included subscription, unless the current one is a purchase or an operator assignment (then leave it). Seed the `store-included` package row in a D1 migration `0008_packages_seed.sql` (price 0, AI credits per the billing doc). Tests: true → active and marketing allowed; false → cancelled; false while a purchased package exists → unchanged; older effectiveAt ignored; replayed event id → one write.

## Task 3 — operator route (ruling 3b)
`PUT /api/v1/operator/workspaces/:id/subscription` `{ packageId, status, periodEnd, reason }` (Zod), super-admin only, same auth + `isRevoked` fail-closed check as the other operator writes, audit log line, `setSubscription(source 'operator')`. 404 for an unknown workspace or package. Tests: staff/owner 403; revoked 503/denied; success pushes at once (next marketing send not plan_blocked).

## Task 4 — self-serve checkout (ruling 4c)
- `GET /api/v1/stores/:storeId/packages` (owner/staff): active packages with price and AI credits.
- `POST /api/v1/stores/:storeId/packages/:packageId/checkout` (owner only, session revocation check like top-ups): creates a `package_orders` row (D1 migration 0008: id, workspace_id, package_id, amount_minor from the package, status pending|paid|failed|expired, provider_ref, created_at, paid_at) and a Kashier checkout exactly like `startTopup`; returns the checkout URL.
- Webhook: the existing Kashier webhook dispatches by order kind; a paid package order → `setSubscription(status active, periodStart now, periodEnd +1 month, source 'purchase', ref order id)` exactly once (unique on order id); amount must equal the stored amount, else alert and do not grant.
- Renewal: not automatic (Kashier has no stored-card subscription here): the package runs its period; 7 days before the end the inbox shows "renew" (existing banner area) and the owner buys again; expiry is the existing `subscription_expire` task.
- Web: a Packages section on the wallet screen (owner): list, buy button → redirect to checkout; return page shows pending → active by polling the order. ar + en strings; loading/error/empty states like the other screens.
- Tests: amount tamper refused; replayed webhook grants once; bad HMAC 401; switch off → 404; staff 403; expired session refused.

## Task 5 — docs
`docs/billing.md` (packages section: the three writers, checkout, renewal), help guide 09 (buying a package), `docs/launch/README.md` (switch + Kashier step).

## Review focus
Double grant on concurrent webhooks; amount from the client; a Store `includesWhatsApp=false` wiping a purchased package; version going backwards when two writers race; the Store event emitted before the D1 write commits.
