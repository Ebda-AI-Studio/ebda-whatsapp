# Packages: limits, seats and yearly billing (WA-PRICE-1 / 1a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The approved Ebda WhatsApp packages exist in D1 with their limits; every limit is enforced server-side (deny by default); team access is by explicit seat assignment; packages can be bought monthly or yearly.

**Architecture:** D1 `packages` (control plane) gains limit columns; the entitlement event that already carries `aiCredits` to each workspace DO now also carries the limits, so the DO (the workspace's authority) decides every gate from its own copy, with no entitlement row = deny. Seats live in the workspace DO; the Store staff list and each request's membership check come through the Store bridge adapter (`src/addons/ebda/store-bridge.ts`, contract v1.4), the one file that touches the binding. Yearly = `period_months` on packages, carried through checkout, renewal and refund; AI credits are granted monthly inside a yearly period.

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

### Task P1b: seats by explicit assignment (PR 2, HELD from main until the Store's feat/wa-members-rpc merges)
Shape CONFIRMED 2026-10-26 (identity Ruling ID-19, contract v1.4): membership lives in the STORE and is read through the Store worker's `WhatsAppBridge` service binding (the existing `STORE_BRIDGE`), not ACCOUNTS. There is NO member_removed event: revocation = `memberRole` on every staff request.
**Files:** `src/core/store-bridge.ts` (interface + zod schemas: `listStoreMembers`, `memberRole`), `src/addons/ebda/store-bridge.ts` (the adapter: the ONE place that calls the binding), `src/routes/members.ts`, DO migration (append `seats`), `src/core/identity/middleware.ts`, web Team screen; tests `test/seats.test.ts`, `web/src/TeamScreen.test.tsx`; the FakeStore in `test/helpers/fake-store.ts` gains both methods.
**Interfaces (Store side, contract v1.4):**
- `listStoreMembers(storeId, asUserId)` → `{ items: [{ userId, displayName, role: 'owner' | 'staff', addedAt }] }`: owner + ACTIVE staff only (suspended excluded), no email/phone/credential. `asUserId` = the verified token `sub` and must OWN the store, else `FORBIDDEN`; malformed ids → `INVALID_ID`; a read failure THROWS → we answer 503 and change nothing.
- `memberRole(storeId, userId)` → `'owner' | 'staff' | null`: called on EVERY staff request, no cache (permissions are never-stale); null or a thrown/timed-out call → refuse (`403 no_seat` for null, `503` on error: fail closed either way).
**WhatsApp side:**
- DO `seats(user_id TEXT PRIMARY KEY, assigned_at INTEGER NOT NULL, assigned_by TEXT NOT NULL)`; `seatState(userId)`: seated within the first `memberLimit - 1` by (assigned_at, user_id) → 'seated'; seated beyond → 'over_limit'; else 'none'. The owner never has a row and always counts as one.
- Middleware, staff principal (not owner by `memberRole`, not super admin, not a client token): `memberRole` must return 'staff' AND `seatState` must be 'seated', else refuse. An owner by token whose `memberRole` is not 'owner' is refused too.
- Routes (owner only): `GET /stores/:id/members` (calls `listStoreMembers(storeId, sub)`) → items + seat state + `{ limit, used, overLimit }`; `PUT /stores/:id/members/:userId/seat` → 201, or 403 `seat_limit` with `{ limit }` for the upgrade CTA, or 404 when the user is not an active member; `DELETE .../seat` → 204; the owner cannot be unseated (400).
- Downgrade notice: an applied entitlement that lowers `maxMembers` below the seats in use records an owner notice (Team screen + inbox banner) and alerts `seats_over_limit`; nothing is deleted.

### Task P1c: no package = no service (PR, Opus review; after P1a)
Rulings (2026-10-26, controller-approved; also in the program register):
- **Ruling WA-NOFREE-1** - There is NO free plan (Ahmad; Store ruling D3). `store-included` (price 0) exists only while the Store plan says includesWhatsApp=true (Store Business, paid) and ends with it. A workspace with no entitlement row, or `cancelled`/`expired`, may sign in, read its inbox and see the package list, but cannot send ANY message (every category, OTP included), run the AI agent, or connect/register a number: `403 plan_required` (and the queue path fails the message `plan_required`, settling any hold). Evidence: today only marketing is blocked (`entitlements.ts` marketingBlocked; utility/service/OTP, the agent and number connect stay open). Cost if wrong: a merchant who pays nothing keeps sending on our platform.
- **Ruling WA-GRACE-1** - `past_due` keeps the existing grace (marketing blocked; replies, order/COD confirmations and other utility sends keep working) and the grace is BOUNDED: it ends at the period end, and in any case 7 days after the first failed renewal (`past_due_since` + 7 d), whichever is first; then the workspace is treated as lapsed (WA-NOFREE-1). Meta costs are safe either way: own number bills the merchant's card, the shared number spends the prepaid wallet, which fails closed. Cost if wrong: a past_due merchant sends service messages for up to 7 days unpaid (our platform cost only).
**Interfaces:**
- Entitlement copy gains `past_due_since` (set by the control plane when status first becomes past_due, carried on the event, cleared on active).
- DO `serviceAllowed(sql, now): boolean` = row exists AND (status trialing/active, OR status past_due AND now < min(period_end, past_due_since + 7 d)). `marketingBlocked` unchanged for past_due.
- Gates: every send path (API send, template send, bot/agent replies, store-link outbound, OTP, campaigns), the AI agent turn, and number connect/register/coexistence → `plan_required` when `!serviceAllowed`. Reading, the package list, checkout and the wallet stay open (a merchant must be able to buy).
- Guard test: across D1 seeds, `price_minor = 0` only for id `store-included`; and `store-included` is only ever granted by the Store-plan path (grep the writers of `workspace_subscriptions` with that id).
- [ ] Tests first: no entitlement → each gate refuses; expired → refuses; past_due day 3 → service ok, marketing refused; past_due day 8 → refuses; past_due past period_end → refuses; checkout still works with no entitlement.

### Task P2: yearly billing (PR 3, Opus review)
**Files:** `migrations/d1/0015_yearly.sql` (`packages.period_months INTEGER NOT NULL DEFAULT 1 CHECK (period_months IN (1, 12))`, seed the three yearly rows), `src/core/billing/subscriptions.ts` (`MONTH_SQL` → period length from the package), `package-orders.ts` + `instapay.ts` (amount = the package's price; period = its months), refunds (yearly rule), `entitlements.ts` + `ai/credits.ts` (monthly grant inside a long period: a `credit_month` task at each monthly anniversary inside the period grants that month's allowance and expires the previous month's unused grant), docs.
- Refund (yearly): `unusedWholeMonths x floor(price / 12)`, current month never refunded, the wallet's debt settled first (WA-REFUND-1); a partial refund shortens the period by the refunded months.
- [ ] Tests first: Review Focus 5; 12 monthly grants in a year (never 12x at once); a monthly package still renews/refunds exactly as today (regression); a yearly order through InstaPay and Kashier sets a 12-month period.

## Order
P1a → (Opus review) → merge → P1c (Opus review) → merge; P1b built, held until the Store RPC merges; P2 after P1c. Search track (A2-A5, B2-B3) continues as the second track.
