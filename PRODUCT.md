# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
React + Vite single-page app served as static assets by the same Cloudflare Worker (`ebda-wa`); live updates over a Durable Object WebSocket. Everything on Cloudflare (Workers, DO SQLite per workspace, D1, R2, Queues, Workflows, Analytics Engine). Confirmed by Ahmad 2026-10-24.

## Users
Both equally (Ahmad, 2026-10-24):
- **Ebda Store merchants and their 1–3 staff in Egypt**, mostly on a phone between other work: answering shoppers, confirming or refusing COD orders, sending shipping updates.
- **Ebda AI Studio digital-marketing clients**, often a small team at desks on laptops handling many chats and campaigns at once.
One Ebda AI Studio account signs in to every Ebda product (accounts.ebda.app, passkeys).

## Product Purpose
Ebda Chat lets a business sell, confirm and support entirely inside WhatsApp: the store's catalog in WhatsApp, ordering through the catalog or an AI agent, COD or a payment link, order and COD confirmations, shipping updates, OTP, a shared inbox, and marketing campaigns. Success: orders confirmed faster with fewer refused COD deliveries, and replies that feel instant.

## Positioning
Built into Ebda Store: the inbox knows the customer's orders, COD status and catalog because Ebda Store is the source of truth for orders, stock and prices, joined by one customer key and one account. Egyptian-Arabic-first, priced in EGP with Meta's fees passed through from a prepaid wallet.

## Operating Context
- A merchant opens a chat and needs the customer's order context beside the messages; on a phone it is one tap away (collapsible), on desktop always visible (Ahmad, 2026-10-24).
- Speed of replying matters as much as context: instant load, quick replies and templates.
- Meta rules shape the workflow: the 24-hour customer-service window, approved templates outside it, opt-out, and per-number messaging limits.
- Packages: Ebda Store Business includes the Ebda Chat Store package; features from the package, Meta fees from a prepaid EGP wallet, AI replies from AI credits (Ruling WA-PKG-1, WA-BILL-1).

## Capabilities and Constraints
- Inbox: conversations, search, notes, tags, per-agent assignment, human handoff, realtime.
- Store link: catalog sync, ordering in chat, COD confirmation, payment links, shipping updates (contract: business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md).
- Self-service onboarding: connect and verify an own number, or use a paid shared Ebda Chat number; guides on help.ebda.app (Ruling WA-SHARED-1).
- White-label copies (e.g. Khawarz) reuse the brand-neutral core with their own brand; the core must never hard-code Ebda.
- Undecided: package prices, wallet margin, whether the margin applies to Meta's free 1,000 service replies.

## Brand Commitments
- Product name always "Ebda Chat", master brand Ebda AI Studio; never bare "Ebda" (BRAND-NAME-1, BRAND-ARCH-1). Ruling WA-RENAME-PLAN-1: the product name carries no "WhatsApp" (Meta forbids it in app names, and the Meta app stays "Ebda WB"); WhatsApp appears only in describing sentences ("on WhatsApp").
- Logo pack: business/brand/logo-2026-10-22/ (product lockup `04b-product-whatsapp, to be redrawn as 04b-product-chat`, symbol, app icons, favicon). Brand tokens: Night #0A0B0C, Gold #B08D57, Lift #CBA873, Cream #FAF8F3; Playfair Display (headlines), Inter (UI).
- No orange anywhere in Ebda's own UI. Metallic gold/brass on deep grounds is the house taste.
- Copy: Egyptian Arabic in full sentences, neutral buttons; never name infrastructure providers in user-facing copy.
- Arabic-first, right-to-left; no per-letter text animation (breaks Arabic joining); mirror directional motion in RTL.

## Evidence on Hand
No customers, testimonials or usage numbers yet (pre-launch). Do not fabricate any. Live spike endpoint exists; Meta test number pending.

## Product Principles
1. The customer's order is the context: every chat surface answers "what did they buy and what state is it in".
2. Instant beats clever: replying is never blocked by loading, layout or decoration.
3. One identity, one truth: Ebda Store owns orders; Ebda Chat talks.
4. Egyptian Arabic first, English second, both complete.
5. Honest costs: show Meta and AI costs plainly before a send that spends money.

## Accessibility & Inclusion
WCAG 2.2 AA; 44px touch targets on phone; full keyboard use on desktop; screen-reader names in Arabic and English; reduced-motion respected.
