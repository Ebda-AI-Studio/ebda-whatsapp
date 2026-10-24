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

## Phase 7 — Billing (backend agent; design CORRECTED by the Opus money review 2026-10-25)

**Blocking question (Ahmad, Q1):** who pays Meta for a merchant's OWN number? `funding` per number decides it: `merchant_card` (Tech Provider: Meta bills the merchant's card → we never debit the wallet for Meta, we only show Meta's cost) or `ebda_line` (shared number / Solution Partner credit line → the wallet pays). Build both; default `merchant_card` for own numbers, `ebda_line` for the shared number.

### 7.1 Packages + entitlements (D1 + DO)
D1 `packages`, `workspace_subscriptions(…, version)`. Events carry a version; the DO keeps the entitlement copy, ignores older versions, a pushed update is retried; a scheduled `subscription_expire` task acts at period end; a daily D1 reconcile only re-sends events (never a TTL). `past_due` from the Store blocks marketing only. Cancelled workspace keeps its wallet + ledger (refund policy Q7).

### 7.2 Money tables
DO (authoritative, atomic with queueOutbound/claimSend): `wallet_ledger(id, at, kind topup|meta_charge|meta_adjust|ai_charge|refund|chargeback|adjustment|grant|expire, net_minor, vat_minor, amount_minor, balance_after, ref UNIQUE, wamid, category, usd_micros, rate_ver, fx_ver, actor, note)` append-only (triggers); `wallet_holds(ref PK, parent_ref, amount_minor, category_est, state held|charged|released|expired, wait_until, expires_at)`; `billable_sends(wamid PK, hold_ref, number_id, country, category_meta, type, billable, delivered_at, charged_ref)` — **never erased**; `ledger_outbox(ref PK, row_json, drained_at)` written in the same transaction and drained to D1 `ledger_mirror(workspace_id, ref UNIQUE)`; `credit_ledger` same shape. Money tables carry no phone numbers or names, are added to the backup set, and restore has a trigger-bypass path. Erasure never touches them.
D1: `number_funding(phone_number_id PK, funding)`, `rate_cards(ver, effective_from, country, category, usd_micros)`, `fx_rates(ver, effective_from, egp_per_usd_micros, buffer_bps)` — immutable effective-dated versions published ≥ 24 h ahead, pulled into each DO daily and on push; `topups(order_id PK, workspace_id, amount_minor, currency, state)`.
**Invariants:** each balance write reads `balance_after` and writes the new row in one `transactionSync` (no await; rate data passed in); `available = balance − Σ held`; one charge per wamid; every terminal message state settles its hold (`settleHold(key, outcome)` + a guard test enumerating markEnqueueFailed, claimRow opted-out drop, recordOutbound non-retryable, 131049 failed, dropped/erased, webhook failed); money rows are never deleted; nightly D1 mirror sum = DO sum.

### 7.3 Charging (WA-BILL-1), only for `ebda_line` numbers
- Parse Meta's `pricing {billable, pricing_model, category, type}` on every status (webhook-schema + status event row).
- Hold at queue/claim (auto-replies too, created in claimRow): estimate by RECIPIENT country + template category from the in-effect rate version; campaign pages hold a parent `camp:<id>:p<n>` that per-message holds draw from (no double reservation; deterministic refs survive Workflow retries).
- `sent` + pricing → re-estimate the hold to Meta's category. Charge only on the first `delivered`/`read` with `billable` (ref `meta:<wamid>`), at the rate version in effect at delivery time; Meta's billed category wins (difference → `meta_adjust`); `pricing_model ≠ PMP` → `unpriced` + alert, no charge. Not billable → release. `failed` with no charge → release. No status by template TTL + 24 h → `expired` by a sweep; a late billable event still charges (no hold).
- Price: `piasters = roundHalfEven(usd_micros × fx_micros × (10000 + margin_bps) / 10^14)` in BigInt, once per row; VAT stored per row (`vat_minor`) per Q5; statements sum stored rows, never recompute.
- Pre-send: marketing needs `available ≥ estimate` and no debt, else `wallet_empty` (campaign pauses); service-in-window and authentication may go down to `−credit_limit_minor` (Q3); service replies held at 0 while the local monthly count per number < 950; utility waits until `wait_until = min(created + 48 h, window end, order deadline)` then `failed/wallet_empty_expired` (shown, event to the Store); authentication that cannot be paid fails immediately so the Store falls back to email (OTP-1). Negative balance is allowed explicitly (late charges, chargebacks): debt blocks marketing + new holds; the next top-up pays debt first.
- Handle `template_category_update` (re-check opt-out and re-hold when a template becomes marketing). Monthly reconcile of `ebda_line` numbers against Meta pricing analytics; alert on any difference.

### 7.4 Top-ups (Kashier), behind `TOPUPS_ENABLED`
Pending `topups` row in D1 at session start (owner only + `Accounts.isRevoked(sid)`); webhook HMAC (constant-time) over Kashier's documented fields, requires SUCCESS and amount/currency/order-id match, workspace taken from the row (never the payload); never credit from the browser redirect; a scheduled Kashier inquiry repairs lost webhooks; refund/chargeback → negative rows for operator review; card-fee policy Q4. Credit ref `kashier:<transactionId>`, debt settled first.

### 7.5 AI credits, statement, alerts
AI: hold 1 credit before the LLM call, settle after (concurrent messages cannot overdraw); grants `grant:<period_start>:<package>`, upgrade tops up the difference, `expire:<period>` row for unused granted credits, purchased credits roll over; BYO-key workspaces never debited. `GET /wallet`, `GET /wallet/statement?month=` (stored rows + category totals, CSV), low-balance event + daily email; operator `adjustment` rows need actor + reason (second approver above a threshold). `wallet_wait` releases FIFO up to available, re-checking window/opt-out/expiry.

**Ahmad decided 2026-10-25:** Q1 = own numbers are `merchant_card` (Meta bills the merchant; the wallet never pays Meta for own numbers; the wallet covers the shared number and AI credits) — Ruling WA-FUND-1 · Q2 = margin 0% for now (`margin_bps = 0`) — WA-MARGIN-1 · Q3 = overdraft 50 EGP (`credit_limit_minor = 5000`), marketing stops at zero, utility wait 48 h — WA-OVERDRAFT-1 · Q4 = the merchant pays Kashier's card fee on top of the top-up amount (wallet credited the exact amount) — WA-TOPUP-FEE-1.
**Ahmad 2026-10-25 (follow-up):**
- **WA-MARGIN-1 (updated):** margin is editable by the super admin (identity `pa: super_admin`) in an **Operator** screen; D1 `pricing_settings(ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, actor, reason)` — effective-dated, never retroactive (price by the version in effect at delivery), every change audited (actor, old→new, required reason); optional per-workspace override `workspace_pricing_overrides(workspace_id, ver, effective_from, margin_bps, actor, reason)`. Route group `/api/v1/operator/*` behind `requireSuperAdmin`.
- **WA-SHARED-FREE-1:** on the shared number every service reply is charged at the normal rate during the month (predictable price); at month close a `shared_number_trueup` task compares Meta's actual cost for that number with what was charged and credits the difference to each workspace **pro-rata to its billable service replies** (`meta_adjust` rebate rows, ref `trueup:<yyyy-mm>:<workspace>`); own numbers are unaffected (Meta bills the merchant directly).
- **WA-REFUND-1:** wallet balance is refundable for 12 months after cancellation, debt settled first; refund to the original method via Kashier refund API against top-ups FIFO, else bank/InstaPay after an identity check; not refundable: card fees already paid, package-granted AI credits, the current package period (access to period end); purchased AI credits refundable only unused within 14 days; minimum refund 50 EGP; financial records never deleted on cancellation/erasure (retention). Operator screen: refund requests queue (approve → Kashier refund → `refund` ledger rows). Terms of service text + legal check before launch.
**Still open:** Q5 VAT presentation (depends on Ebda AI Studio VAT/e-invoice registration) · Q6 FX buffer + free-tier split on the shared number · Q7 cancelled workspace wallet refund.

**UI (controller):** Operator screen (super admin only: margin, overdraft, FX buffer, rate-card versions, per-workspace overrides, refund queue, change log), Wallet screen (balance/available/debt, top-up when enabled, statement by month with category + VAT totals), low-balance banner, cost estimate (EGP incl. VAT) before any send that spends money, package card, "Meta bills your card" notice for `merchant_card` numbers.

## Finish
Per phase: touched tests per task, full suite once at the end of the phase, `tsc` 0, audit 0, gitleaks clean, pushed (no CI/merge/deploy). Opus design review of Phase 7 before building it; one Opus whole-branch review at the end of Phase 7; one fix pass.
