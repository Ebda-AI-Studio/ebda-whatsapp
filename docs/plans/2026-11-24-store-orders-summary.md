# Plan: orders and sales summary for the owner assistant (2026-11-24)

Finish line (evidence in the PR): (1) "كام طلب النهارده؟" / "What were my sales this week?" on a store-linked workspace is answered with figures that came from the Store, in the question's language; (2) the same question on a Chat-only workspace keeps the fixed no-source reply; (3) staff get "owner only", never a number; (4) a figure the tool did not return never reaches the merchant; (5) nothing else changes (best sellers, coupons, other tools).

Pattern: same as `store_top_products` (stack: store #1093 + wa #202). Store: `getOrdersSummary` on `WhatsAppBridge` (owner only, live role, per-store token bucket, 60 s per-store+period cache, BOUNDED-stale). Chat: `GET /store/orders-summary` (owner, `person_only`) -> tool `store_orders_summary` (free read, capability `store.orders-summary`).

Definitions (Store ruling CHAT-ASSIST-ORDERS-1): orders = the dashboard revenue population; sales = paid OR delivered cash-on-delivery (CHIP-COD-DELIVERED-1), net of refunds; refunds = completed non-exchange returns vs payment refunds (the larger, capped at the order total); average = sales / collected orders. Periods are Cairo windows (week from Saturday).

Steps: 1 Store RPC + pure summary + tests (done) -> 2 Chat bridge types/adapter/fake -> 3 route + scopes + authz matrix -> 4 tool + keywords + capability + NEEDS_STORE -> 5 `observeTurn({ storeLinked })`: the fixed reply only for Chat-only workspaces -> 6 ar+en guide + docs -> 7 tests that fail without each piece (mutation checks in the PR).

Out of scope: staff access to sales figures (owner decides later), profit, comparisons with the previous period, a screen.
