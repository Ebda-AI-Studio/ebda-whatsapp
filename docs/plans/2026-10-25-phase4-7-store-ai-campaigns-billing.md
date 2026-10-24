# Ebda WhatsApp Phases 4–7 (Store link, AI agent, Campaigns, Billing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the product side of Ebda WhatsApp: the Ebda Store link (catalog, ordering in chat with COD / payment link / InstaPay, COD confirmation, shipping updates), the AI agent, campaigns, and billing (packages, wallet for Meta fees, AI credits), all on Cloudflare.

**Architecture:** Same Worker + `WorkspaceDO` (SQLite per workspace) + D1. Store integration through the agreed contract only: Queue `ebda-wa-events` (Store → us), Queue `ebda-store-events` (us → Store), Service Binding `STORE_BRIDGE` (RPC `WhatsAppBridge`). Until the Store side lands, the bridge is an interface with a contract-faithful fake used by tests and, behind a switch, by the sample UI. Campaigns run as Cloudflare Workflows. The AI agent uses an `LlmProvider` interface (Workers AI default; bring-your-own key for white-label). Money lives in an append-only ledger inside the workspace DO.

**Tech Stack:** program stack; Cloudflare Workflows; Workers AI binding `AI`; Vectorize index `ebda-wa-kb` (Phase 5); Analytics Engine for `commerce_outcomes`.

**Spec:** program plan (`docs/plans/2026-10-24-ebda-whatsapp.md`, phases 4–7 rows + Global Constraints), Store contract (`business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md` incl. the 2026-10-25 addendum), PRODUCT.md, DESIGN.md, and Ahmad's rulings: WA-PKG-1 (packages; Store Business includes the Store package), WA-BILL-1 (charge every Meta-billed message), WA-SHARED-1 (self-serve), OTP-1 (email first; WhatsApp OTP optional, off by default), PAY-INSTAPAY-1 (InstaPay is a payment method).

**Port, don't copy (Ahmad 2026-10-25):** the old product (`~/Desktop/projects/Force-AI/internal-projects/whatsapp-bulk-sender`, READ-ONLY, never commit there) already had the AI bot, campaigns and catalog ordering. Port its LOGIC and test cases, rebranded, onto this Cloudflare architecture: `backend/src/services/wa-ordering.js` (ordering state machine rules), `metaCatalogService.js` (catalog sync), `botIntentService.js` + `botIntentEval.js` + `botCopyDefaults.js` + `bot-service-router.js` (AI intent, eval cases, copy, routing), `campaignSender.js` (dedupe, daily limits, component building), `routes/contacts.js` + `utils/phoneNumber.js` (CSV import), `routes/segments.js`, `routes/tracking.js` (link tracking). Bot design rules from memory `feedback-wbs-bot-state-machine-design-rules` apply: image burst then list, pagination encoded in row ids, no terminal state, locale-aware names, 150 ms between sends, quick ack before any LLM call.

## Global Constraints
- Everything in the program, Phase 1 and Phase 2–3 Global Constraints.
- Ahmad: push allowed, **no CI, no merge, no deploy**; light Mac (touched tests per task, full suite once per phase, no Docker/servers except the UI audit gate).
- Max 2 agents at once (one backend agent per phase + the controller's UI work; one Opus review at the end, plus an Opus design review of Phase 7 before it is built).
- `src/core/**` never names Ebda; Ebda copy and defaults in `src/addons/ebda/**`. No legacy strings (guard).
- Store owns orders, stock, prices and payment state. We never write them; we call the bridge.
- Money: integer piasters (EGP minor units) everywhere; USD rates in micro-dollars; no floats in ledger math; every money write idempotent by a unique reference.
- Meta compliance: marketing only to contacts not opted out; free-form only inside the 24 h window; AI agent replies only inside the window; templates otherwise.

## Review Focus
1. **A COD confirmation request arrives twice** (Queue redelivery) → one template sent, one `cod_pending` tag, one outcome recorded → Task 4.1 test.
2. **Customer pays with InstaPay and sends a screenshot** → proof forwarded once to the Store, order stays `pending_payment` until the Store confirms → Task 4.4 test.
3. **The wallet runs dry mid-campaign** → marketing sends stop and the campaign pauses with a reason; utility confirmations are queued (not dropped) and the merchant is warned → Tasks 6.3 + 7.3 tests.
4. **Meta reports a message as billable twice** (status redelivery) → charged once → Task 7.3 test.
5. **The AI agent is asked something it cannot answer, or the customer asks for a human** → handoff, bot silent for the handoff window, staff notified → Task 5.3 test.

---

## Phase 4 — Ebda Store link (backend agent)

### 4.0 Bridge interface + fake
**Files:** `src/core/store-bridge.ts` (interface `StoreBridge` mirroring the contract §5 incl. the 2026-10-25 addendum: `getStoreProfile`, `listCatalog`, `getProducts`, `createCheckoutLink`, `createOrderFromChat` (`paymentMethod: 'cod' | 'link' | 'instapay'`), `getPaymentLink`, `recordCodOutcome`, `attachPaymentProof`, `getCustomerAddresses`, `saveCustomerAddress`, `getOrderStatus`, `listCustomerOrders`), `src/addons/ebda/store-bridge.ts` (Service Binding adapter over `env.STORE_BRIDGE`), `test/helpers/fake-store.ts` (in-memory fake that enforces the contract: stock checks, idempotency keys, `pending_payment` for InstaPay). Contract event schemas copied into `src/core/api/store-events.ts` (`ebda-wa-v1` envelope, Zod-3-compatible subset) with a sha256 pin test.

### 4.1 Store → WhatsApp event consumer
Queue consumer for `ebda-wa-events`: dedupe on envelope `id` (DO table `processed_events`), drop stale entity versions. Handlers: `store.plan_changed` → entitlements (Phase 7 hook; store only for now); `store.linked/unlinked`; `catalog.product_upserted/deleted` → schedule catalog sync (4.3); `order.created` → order-confirmation template (when enabled); `order.cod_confirmation_requested` → COD template with Confirm/Refuse quick-reply buttons + tag `cod_pending`; `order.status_changed`; `shipment.updated` → shipping template with tracking URL; `cart.abandoned` → recovery template (marketing → consent + wallet rules); `customer.erased` → `eraseContact`. Templates come from the Ebda addon defaults; each send uses the Phase 2 pipeline (window/consent/throttle). Tests per handler + Review Focus 1.

### 4.2 Orders + COD outcome routes; quick-reply outcomes
`GET /contacts/:waId/orders` (bridge `listCustomerOrders` → `customerOrdersResponse` with `source: 'store'`), `POST /contacts/:waId/orders/:orderNumber/cod-outcome` (owner or staff; bridge `recordCodOutcome`; emits `commerce_outcomes`; removes `cod_pending`). Customer taps Confirm/Refuse on the COD template → inbound button reply → same outcome path. `GET /me` gains `capabilities: { codOutcome: boolean }` (true when `STORE_BRIDGE` is bound) so the UI shows Confirm/Refuse. Outcome to Store via `ebda-store-events` as well as RPC (contract §3).

### 4.3 Meta catalog sync
Port `metaCatalogService.js`: on catalog events, batch upserts to the merchant's Meta commerce catalog (`POST /{catalog-id}/items_batch`, retailer id = variant id, price/availability/image/link from `getProducts`), coalesced per workspace by the scheduler (one `catalog_sync` task, debounced 30 s). NEVER-stale class: every `catalog.*` event schedules a sync; a nightly full reconcile catches misses.

### 4.4 Ordering in chat
Port the `wa-ordering.js` state machine (rules above): browse (catalog / product list messages), Meta `order` webhook (cart from the catalog) → choose payment: **COD** (`createOrderFromChat` cod), **payment link** (`createCheckoutLink`), **InstaPay** (`createOrderFromChat` instapay → send IPA, amount, reference; customer's image reply within 48 h → `attachPaymentProof`) → address (saved addresses or ask) → confirmation. No terminal state; "طلب جديد" restarts. Inside the 24 h window only. Tests: each path against the fake store, InstaPay proof once (Review Focus 2), stock refusal message.

### 4.5 Customer Intelligence
`commerce_outcomes` (CI-1 schema: `buyerKey`, `storeId`, `outcome: confirmed|refused|no_reply`, `orderId`, `at`, `channel: 'whatsapp'`) to Analytics Engine `ebda_ci_outcomes`; `no_reply` scheduled 24 h after a COD request with no answer.

### 4.6 WhatsApp OTP (optional, OTP-1)
Authentication-template send via an internal RPC `sendOtp(storeId, phone, code)` gated by workspace setting `otpViaWhatsApp` (default false); masked everywhere (Phase 2 rule). No UI.

**UI (controller):** live order panel uses `GET /contacts/:waId/orders`; Confirm/Refuse appear when `/me.capabilities.codOutcome`; payment method labels include InstaPay (`t.instapay`); conversation `cod_pending` dot already wired.

---

## Phase 5 — AI agent (backend agent)

### 5.1 Provider + config
`src/core/ai/provider.ts`: `interface LlmProvider { complete(req: { system: string; messages: ChatTurn[]; tools: ToolDef[]; maxTokens: number }): Promise<{ text?: string; toolCalls?: ToolCall[]; usage: { inputTokens: number; outputTokens: number } }> }`; `WorkersAiProvider` (env.AI, model from config), `OpenAiCompatibleProvider` (base URL + key from an encrypted workspace secret, for white-label BYO keys). Workspace setting `agent: { enabled, persona, language, handoffMinutes }`.

### 5.2 Agent loop
Inbound text inside the window, agent enabled, no active human handoff → quick ack only if the reply will exceed 2 s (rule: ack before LLM) → LLM with tools: `search_catalog` (Vectorize over the synced catalog, fallback bridge `listCatalog` filter), `order_status` (bridge), `start_order` (hands to the 4.4 state machine), `handoff_to_human`. Max 3 tool rounds; replies in Egyptian Arabic by default (persona copy in the Ebda addon). Port `botIntentEval.js` cases into `test/ai-eval.test.ts` with a scripted fake provider; record the pass rate.

### 5.3 Handoff + credits
`handoff_to_human` or the words for a human (port intent keywords) → conversation tag `needs_human`, bot silent for `handoffMinutes` (default 120) or until staff replies; realtime event so the inbox highlights it. Every LLM reply debits AI credits (Phase 7 `credit_ledger`); at zero credits the agent stops and hands off. Review Focus 5.

### 5.4 Knowledge base
Merchant FAQ/policy text (settings) chunked and embedded into Vectorize (`@cf/baai/bge-m3`, multilingual) per workspace namespace; retrieved into the system prompt (top 4).

**UI (controller):** agent settings panel (on/off, persona, handoff window, FAQ text), `needs_human` badge + "Take over" in the chat header, AI-authored bubbles marked.

---

## Phase 6 — Campaigns (backend agent)

### 6.1 Contacts + import
Port contacts CSV import: upload to R2 (≤ 10 MB), parse in a Workflow step (header mapping: phone, name, tags), normalise with `normaliseE164`, dedupe, consent source `import:<file>`; report rejected rows. Contacts list API with tags + opted-out filter.

### 6.2 Segments
Port segments: criteria JSON (`tags any/all`, `last_inbound_after/before`, `has_ordered`, `opted_out = false` always enforced for marketing), preview count.

### 6.3 Broadcasts as Workflows
`CampaignWorkflow` (Cloudflare Workflows): steps = resolve audience page (500) → wallet **reservation** for the page's estimated Meta cost (Phase 7) → enqueue sends (template, params per contact) through the Phase 2 throttle → `sleepUntil` next window when the tier is exhausted → repeat. Pause/resume/cancel; scheduling via `sleepUntil(scheduledAt)`; per-recipient status rolled up from message statuses; port `campaignSender.js` dedupe + `daily_send_limit`. Review Focus 3.

### 6.4 Link tracking
`/t/:code` redirect on the Worker (302, `no-store`), click recorded to Analytics Engine with campaign + `buyerKey`; UTM appended; codes per campaign link.

**UI (controller):** Campaigns screen (list with status + progress, create flow: audience → template + params → schedule → cost estimate from the wallet → confirm), Contacts screen with import.

---

## Phase 7 — Billing (backend agent, after an Opus design review of this section)

### 7.1 Packages + entitlements (D1 + DO)
D1 `packages(id, code, name_ar, name_en, monthly_price_minor, ai_credits_monthly, seats, features_json, active)`, `workspace_subscriptions(workspace_id PK, package_code, source: 'store_business'|'direct'|'operator', status: 'active'|'past_due'|'cancelled', period_start, period_end, updated_at)`. `store.plan_changed` (Phase 4.1) → when `includesWhatsApp`, set `package_code='store'`, `source='store_business'`; downgrade → keep until period end, then `cancelled`. Entitlements are NEVER-stale: the DO keeps a copy updated **only** by the event/operator path (no TTL) and every feature gate reads the DO copy.

### 7.2 Wallet ledger (DO)
`wallet_ledger(id, at, kind: 'topup'|'meta_charge'|'ai_charge'|'refund'|'adjustment', amount_minor INTEGER signed, balance_after INTEGER, ref TEXT UNIQUE, category TEXT, wamid TEXT, note TEXT)`, append-only by SQLite triggers (`BEFORE UPDATE/DELETE … RAISE(ABORT)`). `wallet_holds(ref UNIQUE, amount_minor, created_at, expires_at)`. `available = last balance_after − Σ active holds`. Every write inside one `transactionSync` with the balance read. `credit_ledger` for AI credits with the same shape (credits instead of piasters), monthly grant from the package (`ref = grant:<yyyy-mm>`).

### 7.3 Charging Meta messages (WA-BILL-1)
Before a billable send: estimate from the current rate card (category from the template; service replies estimated at the utility rate) → hold `hold:<idempotencyKey>`; if `available < estimate`: **marketing** → refuse `wallet_empty` (campaign pauses); **utility/authentication/service** → queued in `scheduled_tasks` (`kind='wallet_wait'`) and a `wallet.low` realtime event + email warning, never dropped. On the status webhook's `pricing` object (`billable`, `category`, `pricing_model`): billable → convert the hold to `meta_charge` (`ref = meta:<wamid>`; a redelivered status is a no-op by the unique ref — Review Focus 4); not billable (free service allowance, free entry point) → release the hold. Failed sends release the hold. Price = `usd_micros(rate_card[country][category]) × fx_egp_per_usd_micros / 1e6` + margin (`margin_bps`, Ahmad sets; default 0 until decided) — computed in integers with banker's rounding to the piaster, stored with the rate-card version on the ledger row. Rate cards and FX are versioned D1 tables (`rate_cards`, `fx_rates`), operator-editable, never code.

### 7.4 Top-ups (Kashier)
`POST /wallet/topups { amountMinor }` (owner only) → Kashier payment session (secret `KASHIER_API_KEY`, merchant id var; documented hosted-checkout API; stubbed in tests) → `POST /kashier/webhook` (HMAC signature verified, Zod) → `topup` credit with `ref = kashier:<transactionId>` (idempotent). Behind switch `TOPUPS_ENABLED` until the Kashier account exists (Ahmad-only item).

### 7.5 Statement + alerts
`GET /wallet` (balance, available, holds, low-balance threshold), `GET /wallet/statement?month=YYYY-MM` (ledger rows + per-category totals, CSV export), low-balance threshold setting → `wallet.low` event + one email per day (Cloudflare Email module from the Store, later).

**UI (controller):** Wallet screen (balance, top-up button when enabled, statement by month with category totals), low-balance banner in the inbox, cost estimate in the campaign flow, package card (included with Store Business / buy).

## Finish
Per phase: touched tests per task, full suite once at the end of the phase, `tsc` 0, audit 0, gitleaks clean, pushed (no CI/merge/deploy). Opus design review of Phase 7 before building it; one Opus whole-branch review at the end of Phase 7; one fix pass.
