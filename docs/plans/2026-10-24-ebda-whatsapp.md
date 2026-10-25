# Ebda WhatsApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ebda WhatsApp runs on Cloudflare only and serves three kinds of customer from one brand-neutral core: Ebda Store merchants (catalog ordering, order and COD confirmations, shipping updates, OTP, AI agent), Ebda AI Studio marketing clients (campaigns, OTP, inbox, AI agent), and later a white-label copy for other companies.

**Architecture:** One Worker `ebda-wa` (Hono) takes Meta webhooks and the API. Each tenant ("workspace") is one SQLite Durable Object `WorkspaceDO` (contacts, conversations, messages, templates, campaigns, opt-outs, wallet ledger, AI usage, FTS5). D1 `ebda-wa-platform` is the control plane (phone number / WABA → workspace, store links, packages, entitlements). R2 holds media and archived message bodies, Queues send and retry, Workflows run broadcasts, Analytics Engine counts usage. Everything Ebda-specific (accounts.ebda.app sign-in, Ebda Store link, Customer Intelligence, Kashier self-serve billing, brand) is an add-on under `src/addons/`; `src/core/` never names Ebda.

**Tech Stack:** TypeScript 5.9.3, Hono 4.13.x, Zod 4.6.x, Wrangler 4.152.x, Vitest 4.1.12 + `@cloudflare/vitest-pool-workers` 0.23.x (peer `vitest ^4.1.0`, so NOT Vitest 5), `@cloudflare/workers-types` latest. UI (Phase 3): React + Vite SPA on Workers static assets.

**Spec:** `~/Desktop/projects/Ebda-AI-Studio/business/ebda/plans/2026-10-24-ebda-whatsapp-brief.md` (binding decisions) + `…/plans/2026-10-24-ebda-whatsapp-store-contract.md` (Store ↔ WhatsApp contract) + the decisions captured with Ahmad on 2026-10-24 (section "Design" below).

## Design (decided with Ahmad, 2026-10-24)

**Who it serves**
1. **Ebda Store merchants:** a shopper messages the merchant's WhatsApp number, browses the store's catalog inside WhatsApp (Meta commerce catalog), orders through the catalog or through the AI agent, and picks COD or gets a payment link, all inside WhatsApp. Plus order confirmations, COD confirmations, shipping updates, abandoned-cart nudges, OTP, and marketing campaigns.
2. **Ebda AI Studio digital-marketing clients:** no store. Campaigns to their own number lists, OTP sending, inbox, AI agent.
3. **One Ebda AI Studio account** (Ruling ID-1) for the whole suite, current and future: accounts.ebda.app, audience `whatsapp`, passkeys like Ebda Store. No user or password table here.
4. **White-label copies (first: Khawarz, Kuwait):** a copy of the core under another company's brand, with no Ebda sign-in, no store, no Ebda branding. The AI agent replaces the manual front-desk work (bookings, reservations, secretary work) and connects to the client's own systems (Odoo, SAP, Oracle, CRMs, ERPs) through connectors, with the client's own LLM API key. Packages are sales-led (an operator creates tenants and assigns packages), never self-serve. Built from this core in a later, separate plan.

**Packaging (Ruling WA-PKG-1, Ahmad: "that split works")**
- The **package** pays for features (fixed cost). Ebda WhatsApp has its own packages; **Ebda Store's Business plan includes the Ebda WhatsApp Store package**. Basic/Growth stores can buy it separately.
- A prepaid **EGP wallet** pays Meta's per-message fees (pass-through plus a small disclosed margin). At zero, sending stops (fail closed) after low-balance warnings. Ebda never pays Meta on a merchant's behalf.
- **AI credits** pay for AI agent replies: a monthly allowance in the package, then top-ups.
- **Ruling WA-BILL-1 (Ahmad, 2026-10-24): charge for ALL Meta-billed messages.** Since 2026-10-01 Meta bills service replies (after 1,000 free per number per month) and utility templates inside the 24 h window, so the wallet meters every category: marketing, utility (order/COD/shipping confirmations), authentication (OTP) and service replies. Nothing is assumed free in pricing or copy. Cost if wrong: confirmations and replies become an unbilled cost Ebda absorbs per merchant.
- Meta pricing facts (research 2026-10-03, rates **unverified**): billed per delivered message by category; since 2026-10-01 service replies are free only for the first 1,000 per number per month, then billed at the utility rate, and utility templates inside the 24 h window are billed too. Egypt rates are cited at marketing $0.0644, utility $0.0036, authentication $0.0036, plus 14% VAT. Rates live in a versioned table, never in code.

**Meta account (Ahmad, 2026-10-24)**
- Force AI's Meta assets are NOT used. Ahmad creates a new Meta Business portfolio "Ebda AI Studio" plus a developer app "Ebda WhatsApp". Until the Ebda AI Studio legal entity is registered (Ahmad in Egypt from Mon 26 Oct) we build and test on Meta's free test number. Business verification, Tech Provider status and Embedded Signup for merchants come after.
- Merchants do not need verification to connect; unverified they are capped (about 250 unique customers per 24 h for business-initiated messages); verified they scale in tiers. Many Egyptian merchants lack a commercial register.
- **Ruling WA-SHARED-1 (Ahmad, 2026-10-24): everything is self-service.** Each merchant picks in the app: (a) connect and verify their OWN number (Embedded Signup), or (b) the paid **shared Ebda WhatsApp number** that sends "on behalf of <store>" while they have no papers. help.ebda.app carries step-by-step guides for both (getting Meta Business verification, and using the shared number). The shared number stays off until Ebda AI Studio itself is verified. Cost if wrong: merchants without a commercial register stall at the 250/day cap and churn.

**Store integration:** events and RPC only, per the contract doc (Queues `ebda-wa-events` / `ebda-store-events`, Service Binding RPC `WhatsAppBridge`, `buyerKey = HMAC-SHA256(secret, E.164)`). Ebda Store stays the writer of orders, stock, prices and payments.

**What we keep from the old WhatsApp product** (inventory 2026-10-24, logic only, rebranded, no history): the Meta client and error hints (codes 131049, 131045, 131056, 131026, 131047, 131051, 131053, 1320xx, 2494051), webhook parsing and signature check, the status `applied` flag for out-of-order events, the template-component builder, interactive list/button builders, phone normalisation, the 24 h window helper, the ordering state machine rules, the bot copy and eval cases, the limits map. **Dropped:** Express, Prisma/Postgres, Redis, BullMQ, Socket.IO, polling loops, ffmpeg, the duplicate template tables. **New (absent before):** opt-out/consent, OTP via authentication templates, wallet + ledger, per-agent assignment, a tier-aware throttle using Meta's tier and throughput, packages and billing.

## Global Constraints
- Name: always "Ebda WhatsApp" (BRAND-NAME-1), under Ebda AI Studio (BRAND-ARCH-1); never bare "Ebda". Zero "Force", "FWB", "WBS", "forcemediakw", "force-ai", `force_` strings anywhere in the repo (guard test in Task 0.1).
- `src/core/**` must not contain the strings `ebda`, `Ebda`, `إبدأ`, `ابدأ` (guard test in Task 0.1); brand and Ebda-only behaviour live in `src/addons/ebda/**` and config.
- Cloudflare only: no Neon, Railway, Redis, Inngest, OneSignal. Sentry is the one allowed error tracker (project `ebda-whatsapp`, org `whisky11`).
- Cloudflare account: personal/Whisky 11 (`wrangler whoami` must show `as.montaseer@gmail.com` before any deploy).
- No preview/staging environments (INFRA-PREVIEW-1): production only, new behaviour behind switches.
- Wake on webhooks/events only: no polling, no crons shorter than 1 h.
- Every write path is tenant-scoped by construction: the only way to touch tenant data is `env.WORKSPACE_DO.get(idFromName(workspaceId))`; D1 holds no message content.
- Message bodies over 1 KB and all media go to R2; bodies up to 1 KB are kept in full in the DO (`messages.body`), plus a 280-grapheme preview for FTS5.
- Zod at every edge (webhooks, API, queue messages, RPC, contract events). The contract file must use the Zod subset that also runs on Zod 3 (Store uses `zod ^3.22.4`): `z.object`, `z.string().uuid()`, `z.enum`, `z.number().int()`, `z.literal`.
- Never log raw phone numbers or message bodies; log `buyerKey`/the last 4 digits.
- Secrets via `wrangler secret`: `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_SYSTEM_TOKEN` (spike), `TOKEN_ENC_KEY`, `SUITE_BUYER_KEY_SECRET`, `SENTRY_DSN`.
- Arabic-first RTL UI, Egyptian Arabic full sentences, no orange (Ebda palette: Night `#0A0B0C`, Gold `#B08D57`, Lift `#CBA873`, Cream `#FAF8F3`); impeccable pass on every UI change.
- LEAN mode: Sonnet executes; Opus only for the final whole-branch review and the Phase 7 (money) design; run touched tests per task, full suite at PR end; merge on green only; verify production after every deploy.

## Review Focus
1. **Duplicate webhook delivery** (Meta retries the same `wamid`): stored once, replied to once → Task 0.3 test `duplicate inbound delivery stores one message` and Task 0.4 test `redelivered queue message sends to Meta once`.
2. **Status events out of order** (`read` before `delivered`, `failed` after `sent`): the message ends in the highest state and every event is recorded → Task 0.4 test `out-of-order statuses keep the highest state`.
3. **Webhook for a number no workspace owns** (a test number, a disconnected merchant): returns 200 so Meta stops retrying, touches no DO, counts it → Task 0.3 test `unknown phone_number_id is acknowledged and dropped`.
4. **Tampered or unsigned webhook body**: 401, nothing stored, and the check runs on the raw bytes, not re-serialised JSON → Task 0.2 tests.
5. **Arabic and emoji text** round-trips byte-exact from webhook to SQLite to the outbound reply → Task 0.3 test `arabic and emoji text round-trip`.

---

## Program phases (each phase after 0 gets its own detailed plan file in `docs/plans/` before it starts)

| Phase | Delivers | Exit gate |
|---|---|---|
| **0. Spike** (this file, detailed below) | One workspace DO receives a real Meta test-number webhook and replies; latency and cost measured | Gates in Task 0.6 |
| 1. Foundation | CI on the Umbra runner (lint, typecheck, affected tests; `EBDA_RUNS_ON` pattern, no remote Actions cache on self-hosted), Sentry, Workers Logs + Logpush to R2 (30 d), identity adapter (`IdentityVerifier` interface + `EbdaAccountsVerifier` per `business/ebda/plans/2026-10-24-ebda-identity-token-contract.md` v1: `jose`, ES256 only, `iss https://accounts.ebda.app` exact, `aud whatsapp`, ≤60 s skew, JWKS cached ≤10 min with one refetch on unknown `kid`, request `storeId` ∈ `stores[].id` else 403, `Accounts.isRevoked(sid)` for billing/export/staff actions; tested against a fake local issuer with pinned keys), `buyerKey()` + E.164 normaliser with the pinned vector from the Store contract, D1 schema v1, WorkspaceDO schema v1 (versioned migrations), nightly DO/D1 export to R2 + Mac pull (G8), erasure job per surface (G10), billing alerts (G9) | Restore drill equal counts/checksums; erasure test per surface green |
| 2. Messaging core | A per-DO alarm scheduler (one alarm slot multiplexed: nightly backup + campaign/throttle wake-ups + R2 delete retries), full Meta client (text, template, media, interactive, catalog/product-list), template sync + submit, inbound media → R2 (Meta URLs expire), outbound MIME limited to what Meta accepts (no ffmpeg), per-number throttle in the DO using Meta's tier + throughput (separate from error 131049), exactly-once send (claim row + stable idempotency key), opt-out keywords (STOP / إلغاء / وقف) and consent flags, 24 h window, quality/tier/account alerts | Send/receive matrix green on the test number; opt-out blocks marketing sends |
| 3. Inbox UI | SPA: conversations, search (FTS5), notes, tags, per-agent assignment, handoff to human, realtime via DO WebSocket hibernation, Arabic-first RTL, impeccable audit | Browser-driven e2e on the test number; axe 0 violations ar/en at 390/1280 |
| 4. Ebda Store add-on | The contract doc: event consumers, RPC client, Meta catalog sync on `catalog.*` events, ordering state machine (catalog → cart → COD or payment link), order + COD confirmation flow, shipping updates, abandoned cart, `commerce_outcomes` to Customer Intelligence, OTP via authentication template exposed to Store/accounts | A real order placed in WhatsApp on a demo store appears in Ebda Store with stock reserved; COD outcome lands in Store |
| 5. AI agent | `LlmProvider` interface (Workers AI default where good enough; bring-your-own key for white-label), quick ack before the LLM call, tools (catalog search, order status, address, handoff), Vectorize knowledge base, AI credits metering, eval suite ported from the old product's eval cases | Eval pass rate ≥ the old bot's on the ported cases; per-reply cost measured |
| 6. Campaigns | Contacts + CSV import via R2, segments, broadcast as a Workflow (paced by the Phase 2 throttle), scheduling with Workflow sleep (no polling), marketing requires an opt-in flag, wallet reservation before a broadcast starts, link tracking | 1,000-recipient broadcast on the test WABA: exactly-once, paced, wallet debited per delivered message |
| 7. Billing (Opus design review) | WA-BILL-1: every Meta-billed category metered from the wallet (marketing, utility, authentication, service after Meta's 1,000/number/month), category taken from Meta's `pricing` object on each status webhook; packages + entitlements in D1, `store.plan_changed` consumer (NEVER-stale, event-invalidated), Kashier subscription + wallet top-up (shared module with Ebda Store), append-only ledger in the DO, versioned Meta rate card (USD, FX buffer, 14% VAT), AI credits, fail-closed at zero, usage statement | Ledger sum = Meta billed (on test traffic); zero balance blocks marketing, never silently drops a utility confirmation (it is queued and the merchant is warned) |
| 8. Onboarding + launch | Deploy order: create R2 `ebda-wa-backups` (+30-day lifecycle) BEFORE the first deploy that binds it; fully self-serve onboarding (WA-SHARED-1): sign up → pick package → connect own number via Embedded Signup (needs Ebda AI Studio's Meta verification + Tech Provider; blocked on the legal entity) OR switch on the paid shared number; in-app checklist links to the help.ebda.app guides (verification steps, shared-number use; help.ebda.app is a 404 today per the register, so its deploy is a dependency), operator console (support + white-label), ebda.app `/whatsapp` product page, launch checklist | Ahmad-only blockers cleared; production verified per rule F |
| 9. White-label kit | Separate plan: brand config, non-Ebda identity, connector SDK (Odoo first), operator-only packages | Core brand-scrub guard green; Khawarz build deploys to their account |

**Ahmad-only items:** (1) now: create the Meta Business portfolio "Ebda AI Studio" with your own Facebook login (not Force AI's), create the developer app "Ebda WhatsApp" (type Business), add the WhatsApp product, add your phone as a test recipient, and send me the test `phone_number_id`, WABA id, app secret and a temporary token through `wrangler secret put` (never in chat); (2) after the entity is registered: Business verification, display-name approval, Tech Provider application; (3) the Kashier account; (4) the help.ebda.app guide content review; (5) package prices and the wallet margin.

---

## Phase 0: Spike

**Finish line.** Must work: a WhatsApp message from Ahmad's phone to the Meta test number reaches `WorkspaceDO`, is stored, and gets an Arabic auto-reply on the phone. Exercised: `GET/POST /meta/webhook`, D1 routing, DO ingest, Queue `ebda-wa-send`, Graph API send, status webhooks. Must NOT change: Ebda Store and anything outside this repo; no custom domain (workers.dev only). Done = Task 0.6 gates answered with measured numbers in `docs/spike/2026-10-report.md` and a go/no-go Ruling.

**File map (spike)**
- `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.mts`: toolchain and bindings (`WORKSPACE_DO`, `DB` = D1 `ebda-wa-platform`, `SEND_QUEUE` = `ebda-wa-send`, `MEDIA` = R2 `ebda-wa-media`, `USAGE` = Analytics Engine `ebda_wa_usage`).
- `src/index.ts`: Hono app + `queue()` handler export + `WorkspaceDO` export.
- `src/core/meta/signature.ts`: webhook signature check.
- `src/core/meta/webhook-schema.ts`: Zod schema for the webhook payload and `extractEvents()`.
- `src/core/meta/client.ts`: `sendText()` against the Graph API.
- `src/core/routing.ts`: `workspaceForPhoneNumber()` (D1).
- `src/core/workspace-do.ts`: `WorkspaceDO` (SQLite migrations, `ingest()`, `recordOutbound()`, `applyStatus()`).
- `src/core/send-queue.ts`: queue message schema + consumer.
- `src/core/timing.ts`: Analytics Engine stage timing.
- `migrations/d1/0001_platform.sql`, `src/core/do-migrations.ts`.
- `test/*.test.ts`, `test/fixtures/*.json` (real-shaped Meta payloads, Arabic + emoji).
- `scripts/seed-spike.mjs`, `scripts/latency-report.mjs`, `docs/spike/2026-10-report.md`.

### Task 0.1: Toolchain, guards and health route

**Files:**
- Create: `package.json`, `tsconfig.json`, `wrangler.jsonc`, `vitest.config.mts`, `src/index.ts`, `CLAUDE.md`, `test/health.test.ts`, `test/guards.test.ts`

**Interfaces:**
- Produces: `type Env = { WORKSPACE_DO: DurableObjectNamespace<WorkspaceDO>; DB: D1Database; SEND_QUEUE: Queue<SendJob>; MEDIA: R2Bucket; USAGE: AnalyticsEngineDataset; META_APP_SECRET: string; META_VERIFY_TOKEN: string; META_SYSTEM_TOKEN: string; META_GRAPH_VERSION: string }` exported from `src/env.ts`; `app` (Hono) default export with `fetch` and `queue`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/health.test.ts
it('GET /health returns ok and the commit', async () => {
  const res = await SELF.fetch('https://x/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, service: 'ebda-wa' });
});
// test/guards.test.ts
it('repo carries no legacy brand strings', () => {
  // walk src/, test/, docs/, scripts/, package.json, wrangler.jsonc
  expect(findMatches(/force|fwb|\bwbs\b|forcemediakw|force_/i)).toEqual([]);
});
it('core never names the Ebda brand', () => {
  expect(findMatches(/ebda|إبدأ|ابدأ/i, 'src/core')).toEqual([]);
});
```
`findMatches(re, root?)` is a small helper in `test/helpers/grep.ts` reading files with `node:fs` (guards run in a `node` Vitest project, not in workerd). Allowlist (files that must name the banned strings to ban them): `test/guards.test.ts`, `CLAUDE.md`, `docs/plans/**`. Everything else, including `node_modules`-free `package-lock.json`, is scanned.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/health.test.ts test/guards.test.ts`
Expected: FAIL (no app / no helper).

- [ ] **Step 3: Implement** the toolchain pinned to the versions in Tech Stack, `wrangler.jsonc` with `compatibility_date` = today, `compatibility_flags: ["nodejs_compat"]`, the bindings in the file map, DO migration tag `v1` with `new_sqlite_classes: ["WorkspaceDO"]`, `workers_dev: true`, no `routes`. `GET /health` returns `{ ok: true, service: 'ebda-wa', commit: env.COMMIT_SHA ?? 'dev' }`. Two Vitest projects: `workers` (pool-workers, `test/**/*.test.ts` minus guards) and `node` (`test/guards.test.ts`). `CLAUDE.md`: the Global Constraints, condensed.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run && npx tsc --noEmit && npm audit --audit-level=low`
Expected: PASS, tsc exit 0, `found 0 vulnerabilities`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json wrangler.jsonc vitest.config.mts src/index.ts src/env.ts CLAUDE.md test/health.test.ts test/guards.test.ts test/helpers/grep.ts
git commit -m "feat(spike): toolchain, brand guards and health route"
```

### Task 0.2: Webhook verification (GET challenge + POST signature)

**Files:**
- Create: `src/core/meta/signature.ts`, `test/webhook-auth.test.ts`
- Modify: `src/index.ts` (routes `GET /meta/webhook`, `POST /meta/webhook`)

**Interfaces:**
- Produces: `verifyMetaSignature(rawBody: ArrayBuffer, header: string | null, appSecret: string): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

```ts
it('GET echoes hub.challenge when the verify token matches', async () => {
  const r = await SELF.fetch('https://x/meta/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=123');
  expect(r.status).toBe(200); expect(await r.text()).toBe('123');
});
it('GET rejects a wrong verify token', async () => { /* … */ expect(r.status).toBe(403); });
it('POST with a valid X-Hub-Signature-256 is accepted', async () => { /* sign fixture with test secret */ expect(r.status).toBe(200); });
it('POST with a tampered body is 401 and stores nothing', async () => { /* flip one byte after signing */ expect(r.status).toBe(401); });
it('POST with no signature header is 401', async () => { /* … */ });
it('signature is checked on the raw bytes, not re-serialised JSON', async () => {
  // fixture with "ا" escapes and odd spacing; sign the raw string
  expect(r.status).toBe(200);
});
```
Test env vars via `vitest.config.mts` `miniflare.bindings`: `META_APP_SECRET='test-secret'`, `META_VERIFY_TOKEN='VT'`.

- [ ] **Step 2: Run** `npx vitest run test/webhook-auth.test.ts` → FAIL.
- [ ] **Step 3: Implement** with WebCrypto HMAC-SHA256 (`crypto.subtle.importKey` + `sign`), header format `sha256=<hex>`, constant-time compare (`crypto.subtle.timingSafeEqual` on equal-length buffers; length mismatch → false). The POST handler reads `await c.req.arrayBuffer()` once and passes the same bytes on.
- [ ] **Step 4: Run** `npx vitest run test/webhook-auth.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(spike): Meta webhook verification`.

### Task 0.3: Routing and DO ingest

**Files:**
- Create: `src/core/meta/webhook-schema.ts`, `src/core/routing.ts`, `src/core/workspace-do.ts`, `src/core/do-migrations.ts`, `migrations/d1/0001_platform.sql`, `test/fixtures/inbound-text-ar.json`, `test/fixtures/status-*.json`, `test/ingest.test.ts`
- Modify: `src/index.ts` (POST handler: parse → route → `ctx.waitUntil(stub.ingest(...))` → 200)

**Interfaces:**
- Consumes: `verifyMetaSignature` (0.2)
- Produces:
  - `extractEvents(payload: unknown): { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[] }[]` where `InboundMessage = { wamid: string; from: string; ts: number; type: 'text'|'interactive'|'image'|'audio'|'video'|'document'|'sticker'|'location'|'order'|'unsupported'; text?: string; profileName?: string }` and `StatusEvent = { wamid: string; status: 'sent'|'delivered'|'read'|'failed'; ts: number; errorCode?: number }`
  - `workspaceForPhoneNumber(db: D1Database, phoneNumberId: string): Promise<string | null>`
  - `WorkspaceDO.ingest(batch: { phoneNumberId: string; inbound: InboundMessage[]; statuses: StatusEvent[]; receivedAt: number }): Promise<{ stored: number; duplicates: number; replies: SendJob[] }>`
- D1 `0001_platform.sql`: `workspaces(id TEXT PK, name TEXT NOT NULL, created_at INTEGER NOT NULL)`, `phone_numbers(phone_number_id TEXT PK, waba_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), display_phone TEXT, status TEXT NOT NULL CHECK(status IN ('active','disconnected')))`, index on `waba_id`.
- DO schema v1 (`do-migrations.ts`, applied in `blockConcurrencyWhile`, versioned by `_migrations`): `contacts(id INTEGER PK, wa_id TEXT UNIQUE NOT NULL, profile_name TEXT, last_inbound_at INTEGER)`, `conversations(id INTEGER PK, contact_id INTEGER UNIQUE NOT NULL, last_message_at INTEGER, unread INTEGER NOT NULL DEFAULT 0)`, `messages(id INTEGER PK, wamid TEXT UNIQUE, conversation_id INTEGER NOT NULL, direction TEXT CHECK(direction IN ('in','out')), type TEXT NOT NULL, preview TEXT, body_r2_key TEXT, status TEXT, status_rank INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, created_at INTEGER NOT NULL)`, `message_status_events(id INTEGER PK, wamid TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL, applied INTEGER NOT NULL, error_code INTEGER)`.

- [ ] **Step 1: Write the failing tests**

```ts
it('inbound text is stored in the workspace that owns the number', async () => { /* seed D1 pn-1 → ws-1; post signed fixture; await DO; expect messages count 1, direction 'in' */ });
it('duplicate inbound delivery stores one message', async () => { /* post the same fixture twice */ expect(rows).toHaveLength(1); });
it('unknown phone_number_id is acknowledged and dropped', async () => { /* no D1 row */ expect(res.status).toBe(200); /* no DO created: list DO ids via runInDurableObject is not called; assert USAGE write with blob 'unrouted' */ });
it('disconnected number is treated as unknown', async () => { /* status 'disconnected' */ });
it('arabic and emoji text round-trip', async () => {
  // fixture text: 'عايز أطلب ٢ تيشيرت 👕'
  expect(stored.preview).toBe('عايز أطلب ٢ تيشيرت 👕');
});
it('body over 1 KB goes to R2 with a 280-char preview', async () => { /* expect body_r2_key set, MEDIA.get returns full text */ });
it('a malformed payload is 200 + logged, never a 500', async () => { /* Meta retries on 5xx */ });
```

- [ ] **Step 2: Run** `npx vitest run test/ingest.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Zod schema is permissive (`.passthrough()`) on unknown fields and maps unknown message types to `'unsupported'`. Routing is one D1 read per webhook with no in-isolate cache (a wrong route leaks a message to another tenant; measure the cost in 0.5 before adding any cache). `ingest` runs every insert inside one `ctx.storage.transactionSync`, uses `INSERT … ON CONFLICT(wamid) DO NOTHING` and counts duplicates from `changes`. In the spike, each new inbound text produces exactly one reply job: `{ workspaceId, phoneNumberId, to: from, text: 'أهلاً! رسالتك وصلت لـ Ebda WhatsApp، وهنرد عليك حالاً.', idempotencyKey: 'reply:' + wamid, inboundAt: ts }`. The spike reply copy lives in `src/addons/ebda/copy.ts` (core takes it from config).
- [ ] **Step 4: Run** `npx vitest run test/ingest.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(spike): route webhooks to the workspace DO and ingest idempotently`.

### Task 0.4: Send pipeline and statuses

**Files:**
- Create: `src/core/meta/client.ts`, `src/core/send-queue.ts`, `test/send.test.ts`
- Modify: `src/core/workspace-do.ts` (`claimSend`, `recordOutbound`, `applyStatus`), `src/index.ts` (enqueue the replies returned by `ingest`; `queue()` handler)

**Interfaces:**
- Consumes: `WorkspaceDO.ingest` → `replies: SendJob[]` (0.3)
- Produces:
  - `SendJob = { workspaceId: string; phoneNumberId: string; to: string; text: string; idempotencyKey: string; inboundAt?: number }` (Zod `sendJobSchema`)
  - `sendText(opts: { token: string; graphVersion: string; phoneNumberId: string; to: string; text: string }): Promise<{ ok: true; wamid: string } | { ok: false; code: number; retryable: boolean; message: string }>`
  - `WorkspaceDO.claimSend(idempotencyKey: string): Promise<'claimed' | 'already_sent' | 'in_flight'>`, `recordOutbound(key: string, result): Promise<void>`, `applyStatus(e: StatusEvent): Promise<{ applied: boolean }>`
- Status rank: `sent=1, delivered=2, read=3`; `failed` applies only if the current rank < 2.

- [ ] **Step 1: Write the failing tests** (Graph API stubbed with `fetchMock` from `cloudflare:test`)

```ts
it('a reply job sends once and stores the outbound wamid', async () => { /* expect one POST to /v{ver}/{pnid}/messages, body {messaging_product:'whatsapp', to, type:'text', text:{body}} */ });
it('redelivered queue message sends to Meta once', async () => { /* run consumer twice with same idempotencyKey */ expect(metaCalls).toBe(1); });
it('a retryable Meta error retries the queue message; a permanent one does not', async () => {
  // 131056 / 5xx → msg.retry({ delaySeconds }) ; 131026 → ack + status failed
});
it('out-of-order statuses keep the highest state', async () => { /* read then delivered → status 'read', 2 events recorded, second applied=0 */ });
it('failed after delivered is recorded but not applied', async () => {});
```

- [ ] **Step 2: Run** `npx vitest run test/send.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `claimSend` inserts a `messages` row with `idempotency_key` and `status='claimed'` in `transactionSync` (unique key → `already_sent`/`in_flight`). On a crash between claim and Meta, a claimed row older than 2 minutes may be re-claimed once (record that choice in the code: duplicate risk vs drop risk, from the old product's lesson). `sendText` uses `fetch`, Bearer `META_SYSTEM_TOKEN` in the spike, `META_GRAPH_VERSION` from vars. Error classification: port `META_ERROR_HINTS` into `src/core/meta/errors.ts` with `isRetryable(code)`. The queue consumer config: `max_batch_size: 10`, `max_retries: 5`, DLQ `ebda-wa-send-dlq`.
- [ ] **Step 4: Run** `npx vitest run test/send.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(spike): exactly-once send queue and status ordering`.

### Task 0.5: Stage timing

**Files:**
- Create: `src/core/timing.ts`, `scripts/latency-report.mjs`, `test/timing.test.ts`
- Modify: the webhook handler, `ingest`, the queue consumer (one `mark()` per stage)

**Interfaces:**
- Produces: `mark(env: Env, stage: 'webhook_ack'|'do_stored'|'enqueued'|'meta_accepted'|'unrouted', ms: number, workspaceId?: string): void` → `env.USAGE.writeDataPoint({ blobs: [stage, workspaceId ?? ''], doubles: [ms], indexes: [stage] })`. All `ms` are measured from Meta's message `timestamp` (seconds) AND from webhook receipt; both are written (`doubles: [msSinceMetaTs, msSinceReceipt]`).

- [ ] **Step 1: Write the failing test:** `it('each stage writes one data point', …)` asserts the AE binding mock received `webhook_ack`, `do_stored`, `enqueued`, `meta_accepted` for one inbound message.
- [ ] **Step 2: Run** `npx vitest run test/timing.test.ts` → FAIL.
- [ ] **Step 3: Implement** `mark`; `latency-report.mjs` queries the Analytics Engine SQL API (`https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`, token from env `CF_API_TOKEN`) and prints p50/p95/p99 per stage for the last N hours as JSON.
- [ ] **Step 4: Run** `npx vitest run` (full spike suite) → PASS; `npx tsc --noEmit` exit 0.
- [ ] **Step 5: Commit** `feat(spike): per-stage latency to Analytics Engine`.

### Task 0.6: Live run on the Meta test number, report and go/no-go

Blocked until Ahmad has done Ahmad-only item (1).

**Files:**
- Create: `scripts/seed-spike.mjs`, `docs/spike/2026-10-report.md`, `docs/RULINGS.md`

- [ ] **Step 1:** `npx wrangler whoami` shows `as.montaseer@gmail.com`. Create the resources: `wrangler d1 create ebda-wa-platform`, `wrangler queues create ebda-wa-send`, `wrangler queues create ebda-wa-send-dlq`, `wrangler r2 bucket create ebda-wa-media`; apply `migrations/d1/0001_platform.sql` with `--remote`; Ahmad sets the secrets (`META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_SYSTEM_TOKEN`).
- [ ] **Step 2:** `npx wrangler deploy --var COMMIT_SHA:$(git rev-parse --short HEAD)`; verify `curl -s https://ebda-wa.<subdomain>.workers.dev/health | jq .commit` equals the HEAD short sha.
- [ ] **Step 3:** `node scripts/seed-spike.mjs --phone-number-id <test pnid> --waba <id>` inserts workspace `ws-spike` + the number into remote D1. In the Meta app, set the webhook URL `https://ebda-wa.<subdomain>.workers.dev/meta/webhook` with the verify token, and subscribe to `messages`. Meta's "Verify and save" succeeding is the GET-path proof.
- [ ] **Step 4:** Ahmad sends 1 message to open the 24 h window, then 30 messages (mixed Arabic, emoji, one >1 KB, one image) at roughly 1 every 10 s, then 5 more after 15 minutes idle (DO cold start). Record on the phone: every text got exactly one reply; the image got stored as `type='image'` (no reply needed in the spike).
- [ ] **Step 5:** `node scripts/latency-report.mjs --hours 2 > docs/spike/latency.json` and write the report with: gate table; p50/p95/p99 per stage warm vs after-idle; duplicates seen (Meta redeliveries) and how many were deduped; the D1 routing read cost (ms); cost model from Cloudflare's CURRENT pricing page (fetch it; never from memory) for 1 workspace at 10k messages/month and for 1,000 workspaces, broken down into Workers requests, DO requests + duration, SQLite rows read/written, D1 reads, Queue operations, R2 ops, AE writes; Meta fees are excluded (merchant's) but noted. Pass every number through `benchmark-vet` before quoting it.
- [ ] **Step 6:** Gates (all must hold): (G1) 31/31 texts got exactly one reply and 0 duplicate replies; (G2) webhook ack p95 < 300 ms (Meta retries after 20 s); (G3) inbound → `meta_accepted` p95 < 1.5 s warm and < 3 s after idle; (G4) zero messages landed in a workspace other than `ws-spike` (query every DO id created); (G5) computed infra cost per 1,000 messages written down with its inputs labelled measured/guess. The gate thresholds are guesses set before measuring; if one fails, record the cause and stop.
- [ ] **Step 7:** `docs/RULINGS.md`: `Ruling WA-SPIKE-1 - <go|no-go>. Evidence: <gate numbers>. Cost if wrong: <one sentence>.` Ahmad makes the call. Open the PR with the report; merge on green; update the register tail in `business/ebda/EBDA-PROGRAM-REGISTER.md`.

**Verification:** `npx vitest run` exit 0; `npx tsc --noEmit` exit 0; `curl /health` commit = main tip after merge; the report lists G1–G5 each as PASS/FAIL with numbers.
