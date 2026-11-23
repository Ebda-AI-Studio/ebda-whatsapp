# Service menu, business hours, store location — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps are TDD (test first, watch it fail).

**Goal:** the three launch-required bot features the Store's previous WhatsApp integration had (docs/store-feature-map.md, items 1–3), merchant-editable, Arabic and English.

**Architecture:** settings live in the workspace Durable Object next to the existing store-link settings (`src/core/store-link/settings.ts`, route `PATCH /store-link/settings`, owner only, Zod). The ordering bot (`src/core/ordering/bot.ts`) consults them: the menu is the bot's entry point, business hours gate the automatic replies, the location is one menu action. Copy in brand packs (`src/addons/<brand>/store-copy.ts`); `src/core` names no brand.

**Spec:** coordinator rulings 2026-10-25 (Store register): (1) configurable service menu (FAQ buttons, ar/en, merchant-editable); (2) business hours + out-of-hours auto-reply (Cairo timezone, DST-safe); (3) send the store's location (location message from a store address + Google Maps link).

## Global constraints
- Repo rules in `CLAUDE.md`. Meta limits: list ≤ 10 rows, row title ≤ 24 chars, description ≤ 72, buttons ≤ 3 with titles ≤ 20 (existing guard test checks bot copy limits; extend it to merchant-entered text by validating at the edge).
- Free-form replies only inside the 24 h window (they are replies to an inbound message, so the window is open); never marketing.
- Envelope frozen: do not edit `src/core/api/store-events.ts`.
- All new UI strings in ar AND en; settings screen states (loading / error with Retry / empty) like the other screens.

## Task 1 — service menu
Settings: `menu: { enabled: boolean, items: Array<{ id: string (slug), title: { ar, en } (≤ 24), answer: { ar, en } (≤ 1024) }> (≤ 8) }`. Bot: a greeting, a restart word (`menu`, `القائمة`, existing restart words) or an unknown text while idle → ONE list: "Order" (existing ordering entry, when a Store is bound), each FAQ item, "Our location" (Task 3, when set), "Talk to a person" (existing handoff). A tapped FAQ row → its answer in the customer's language, then nothing else (no loop). Disabled or empty menu → today's behaviour exactly. Tests: list shape and limits; answer language; Talk to a person opens a handoff; disabled = unchanged (existing ordering tests stay green).

## Task 2 — business hours
Settings: `hours: { enabled, timezone: 'Africa/Cairo' (fixed for now), week: Record<0..6, Array<{ open: 'HH:MM', close: 'HH:MM' }>> (≤ 2 ranges a day; close may pass midnight), awayMessage: { ar, en } (≤ 1024), ordersWhileClosed: boolean (default true) }`. `isOpen(hours, nowMs)` computes the local time with `Intl.DateTimeFormat('en-GB', { timeZone })` (DST-safe; no fixed offset). While closed: the first inbound in a closed period gets the away message once per conversation per closed period (record the period key); the ordering bot keeps working if `ordersWhileClosed`, else the away message replaces the bot; the AI agent follows the same switch. Tests: open/closed at boundaries, an overnight range, a DST transition date for Africa/Cairo (use a fixed `now`), away message sent once per period, ordersWhileClosed both ways.

## Task 3 — store location
Settings: `location: { name (≤ 100), address (≤ 300), latitude, longitude (validated ranges) } | null`. The menu item and the words (`location`, `العنوان`, `فين`, `مكانكم`) send a WhatsApp location message (`type: location`, latitude, longitude, name, address) followed by one text with `https://maps.google.com/?q=<lat>,<lng>`. Tests: payload shape; words trigger it only when set; unset → the words go to the normal flow.

## Task 4 — merchant settings UI + docs
Web: a "Bot" section in the existing settings/agent area (owner edits, staff read): menu items editor (add, reorder, remove; counters for the limits), weekly hours editor, away message, location fields with a map link preview. Contract: extend the store-link settings DTO in `src/core/api/contract.ts` (Zod) — additive. Docs: `docs/store-link.md` (bot), a new help guide `docs/help/{ar,en}/11-service-menu-hours-and-location.md`, link it from the numbers checklist only if it fits (else from the settings screen).

## Review focus
Away message spamming a busy customer; overnight ranges and DST; merchant text breaking Meta limits; menu replacing the ordering entry when a Store is bound; staff editing settings.
