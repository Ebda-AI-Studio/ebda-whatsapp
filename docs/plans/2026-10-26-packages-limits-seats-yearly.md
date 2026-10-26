# Packages: limits, seats and yearly billing (WA-PRICE-1 / 1a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The approved Ebda WhatsApp packages exist in D1 with their limits; every limit is enforced server-side (deny by default); team access is by explicit seat assignment; packages can be bought monthly or yearly.

**Architecture:** D1 `packages` (control plane) gains limit columns; the entitlement event that already carries `aiCredits` to each workspace DO now also carries the limits, so the DO (the workspace's authority) decides every gate from its own copy, with no entitlement row = deny. Seats live in the workspace DO; the Store staff list comes through ONE identity adapter (`src/core/identity/members.ts`) so its final location (accounts or Store bridge) is a one-file change. Yearly = `period_months` on packages, carried through checkout, renewal and refund; AI credits are granted monthly inside a yearly period.

**Tech Stack:** Cloudflare Workers + Hono, D1, DO SQLite, React.

**Spec:** controller messages 2026-10-26 (Ahmad's approved prices WA-PRICE-1 + decisions WA-PRICE-1a). Binding values below are copied from them.

## Global Constraints
- Prices (EGP minor, monthly): `starter` 69000, `growth` 149000, `pro` 349000. Yearly = 9 x monthly: `starter-yearly` 621000, `growth-yearly` 1341000, `pro-yearly` 3141000. `store-included` stays 0 (already seeded).
- AI credits per MONTH: store-included 100, starter 300, growth 1500, pro 5000 (yearly variants: the same per month, granted monthly, never 12x upfront).
- Members (owner counts, cannot be removed): store-included 2, starter 2, growth 5, pro 15.
- Features: store-included and starter = shared_inbox, order_confirmations, templates. growth adds campaigns + order_in_chat. pro adds api + priority_support. Feature keys (exact strings, shared with marketing + Store plan comparison): `members`, `shared_inbox`, `order_confirmations`, `templates`, `campaigns`, `order_in_chat`, `api`, `priority_support`, `ai_credits`.
- Meta fees stay separate (wallet / own card): no package price includes them.
- Deny by default: a workspace with no entitlement row, a lapsed status, or a package without the feature cannot use it. Error `403 plan_feature` with `{ feature }`; seats `403 seat_limit` / `403 no_seat`.
- Copy in Egyptian Arabic full sentences + English; an upgrade CTA wherever a gate refuses in the UI.
- Never-stale (permissions): gates read the DO entitlement copy per request; no TTL cache.
- `src/core/**` never names Ebda; package ids/names are data, not code.
- Money paths: tests first, mutation-checked; Opus review on each PR; heavy suites under the host lock.

## Review Focus
1. A workspace whose entitlement was never pushed (new store) is denied campaigns, order_in_chat and api: never treated as "unlimited".
2. A downgrade (growth → starter) while a campaign is mid-send or the ordering bot is mid-conversation: the next send/turn is refused; nothing already paid is reversed.
3. An integration (client) token on a package without `api` gets 403 on every route, including the identity probe `GET /me`.
4. Seats after a downgrade: the longest-assigned members keep access (owner + oldest assigned up to the limit); the rest get `no_seat` with no data deleted; the owner is told.
5. Yearly refund: unused WHOLE months x (yearly price / 12), current month kept, debt settled first; a refund in the last month returns 0.

---

### Task P1a: limits columns, seeding, event carriage, feature gates (PR 1, mergeable)
**Files:** Create `migrations/d1/0014_package_limits.sql`; Modify `src/core/billing/subscriptions.ts` (SELECT + `toEvent`), `src/core/billing/entitlements.ts` (event schema, DO copy, `featureAllowed`), `src/core/do-migrations.ts` (append: entitlements columns), `src/core/billing/package-orders.ts` (`listPackages` + DTO), `src/core/api/contract.ts` (`packageDto`), `src/routes/campaigns.ts`, `src/core/ordering/bot.ts`, `src/core/identity/middleware.ts`, docs. Test `test/package-limits.test.ts`.
**Interfaces:**
- D1: `packages` + `max_members INTEGER NOT NULL DEFAULT 2`, `feat_campaigns`, `feat_order_in_chat`, `feat_api`, `priority_support` (INTEGER 0/1 NOT NULL DEFAULT 0, CHECK IN (0,1)). Seed starter/growth/pro (INSERT OR IGNORE, then UPDATE store-included to members 2 and all feats 0).
- Event: `entitlementEvent` gains `limits: { maxMembers: int>=1, campaigns: bool, orderInChat: bool, api: bool, prioritySupport: bool }` with `.default()` = the DENY shape (maxMembers 1, all false), so an old event never grants a feature.
- DO: `featureAllowed(sql, feature: 'campaigns' | 'order_in_chat' | 'api'): boolean` = entitlement row exists AND status trialing/active AND the limit is true. `memberLimit(sql): number` (no row → 1).
- `PackageDto` gains `maxMembers`, `features: string[]` (the feature keys above, in that order), `periodMonths` (1 until P2).
- Gates: `POST campaigns`, `POST .../send`, `POST .../resume` → 403 plan_feature `campaigns`; ordering bot `orderingActive` also requires `order_in_chat` (a stopped bot falls back to the plain inbox reply path it already has); a client principal (`principal.client`) on a store whose workspace has no `api` → 403 plan_feature `api` (checked in `requireStore` after the store is resolved, one DO read).
- [ ] Tests first: Review Focus 1, 2, 3; each package's seeded values exactly; listPackages shows starter/growth/pro with features in key order; an event without `limits` grants nothing.

### Task P1b: seats by explicit assignment (PR 2, HELD from main until the controller confirms the identity RPC)
**Files:** Create `src/core/identity/members.ts` (THE adapter), `src/routes/members.ts`, DO migration (append `seats`), web Team screen; tests `test/seats.test.ts`, `web/src/TeamScreen.test.tsx`; vitest stand-in `listStoreMembers` on the ACCOUNTS stand-in.
**Interfaces:**
- Adapter: `listStoreMembers(env, storeId): Promise<{ ok: true; items: { userId: string; displayName: string; role: 'owner' | 'staff'; addedAt: number }[] } | { ok: false; reason: 'unavailable' }>`; today via `env.ACCOUNTS.listStoreMembers(storeId)`.
- DO `seats(user_id TEXT PRIMARY KEY, assigned_at INTEGER NOT NULL, assigned_by TEXT NOT NULL)`; `seatState(userId, ownerId?)`: owner → 'owner'; else seated within the first `memberLimit - 1` by (assigned_at, user_id) → 'seated'; seated beyond → 'over_limit'; else 'none'.
- Routes (owner only): `GET /stores/:id/members` → staff list joined with seat state + `{ limit, used, overLimit }`; `PUT /stores/:id/members/:userId/seat` → 201 or 403 `seat_limit` (body carries `limit` for the CTA); `DELETE .../seat` → 204; the owner cannot be unseated (400).
- Middleware: a staff (non-owner, non-super-admin, non-client) principal whose `seatState` is not 'seated' → 403 `no_seat`.
- Downgrade notice: when an applied entitlement lowers `maxMembers` below the seats in use, record an owner notice (shown on the Team screen and the inbox banner) and alert `seats_over_limit`.

### Task P2: yearly billing (PR 3, Opus review)
**Files:** `migrations/d1/0015_yearly.sql` (`packages.period_months INTEGER NOT NULL DEFAULT 1 CHECK (period_months IN (1, 12))`, seed the three yearly rows), `src/core/billing/subscriptions.ts` (`MONTH_SQL` → period length from the package), `package-orders.ts` + `instapay.ts` (amount = the package's price; period = its months), refunds (yearly rule), `entitlements.ts` + `ai/credits.ts` (monthly grant inside a long period: a `credit_month` task at each monthly anniversary inside the period grants that month's allowance and expires the previous month's unused grant), docs.
- Refund (yearly): `unusedWholeMonths x floor(price / 12)`, current month never refunded, the wallet's debt settled first (WA-REFUND-1); a partial refund shortens the period by the refunded months.
- [ ] Tests first: Review Focus 5; 12 monthly grants in a year (never 12x at once); a monthly package still renews/refunds exactly as today (regression); a yearly order through InstaPay and Kashier sets a 12-month period.

## Order
P1a → (Opus review) → merge; P1b built in parallel, held; P2 after P1a merges. Search track (A2-A5, B2-B3) continues as the second track.
