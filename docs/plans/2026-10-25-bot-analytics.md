# Bot analytics funnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are TDD (test first, watch it fail).

**Goal:** per store, how many customers reach each step of the WhatsApp ordering flow — conversation → browse → cart → checkout → order — over a chosen period, from our own events, with no personal data in analytics.

**Spec:** coordinator ruling 2026-10-25 item (4): "a bot analytics funnel (conversations → browse → cart → checkout → order, per store, from your own events; no raw PII in analytics)".

## Global constraints
- Repo rules in `CLAUDE.md`. No phone numbers, names, wa ids, buyer keys or message text in any analytics row. A funnel row carries only: workspace id, step, day (UTC date in Africa/Cairo calendar terms), and a per-day salted customer token that cannot be reversed or joined across days (HMAC(daily salt, wa_id), salt rotated daily and never stored beyond the day's aggregation) — so "unique customers per step per day" is countable without identifying anyone.
- Storage: the workspace Durable Object (tenant data stays in the DO, per CLAUDE.md); a daily rollup table `bot_funnel_daily(day, step, customers)`; raw step markers kept only for the current day (needed for uniqueness) and deleted at rollup. Erasure of a customer removes their current-day markers (the rollups are counts only).
- Steps are recorded at the bot's existing state transitions (`src/core/ordering/bot.ts`): conversation = first inbound of the day that reaches the front desk/bot; browse = a catalog list sent; cart = first item added; checkout = cart:checkout; order = Store `createOrderFromChat` succeeded. Also count `menu` (service-menu list sent) and `handoff` as side steps. A replayed turn must not count twice.
- Envelope frozen. No new Analytics Engine dataset needed (DO tables suffice); do not add one.

## Task 1 — record + roll up
`recordFunnelStep(sql, { step, waId, now })` and a daily `funnel_rollup` scheduler task (singleton, after local midnight Africa/Cairo, DST-safe via Intl). Tests: each transition records once; a replayed turn records nothing new; uniqueness per day; rollup counts and deletes markers; erasure deletes the customer's markers; no PII column exists (assert the table schema).

## Task 2 — API + UI
`GET /api/v1/stores/:storeId/bot/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD` (owner + staff; ≤ 92 days; Zod) → per step totals and per-day series, today included from live markers. Web: a "Bot results" panel on the Bot screen: the five steps as a horizontal funnel with counts and step-to-step conversion %, a 7/30/90-day switch, ar/en, loading/error/empty states, RTL. Follow the dataviz rules already used in the app (no decorative charts; numbers first).

## Task 3 — docs
`docs/store-link.md` (funnel definitions, privacy design), help guide 11 section "Bot results", `docs/legal` NOT touched (no new personal data processed).

## Review focus
Double counting on replays and Meta redeliveries; a customer re-identifiable from analytics; DST at rollup; today's numbers vs rolled-up days at the boundary.
