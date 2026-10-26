# Launch kit: from "software ready" to live

Every step in order, with who does it. "Ahmad" = needs his identity, a payment, a signature or a click in a vendor dashboard.
"Claude" = can be done in a session once the step before it is done. Nothing here is done by merging alone: a merge is not a
deploy, and a deploy is not a working feature (see step 13).

Last checked against Meta's documentation: 2026-10-25.

## 1. Company and Meta business (Ahmad)
1. **Register Ebda AI Studio** in Egypt (commercial register + tax card). Meta verification needs these documents in the company's exact legal name.
2. **Meta Business portfolio** "Ebda AI Studio" → Security Center → **Business verification** with the commercial register, tax card and a matching website/domain (ebda.app) and email on that domain.
3. **Two-factor authentication** on every admin of the portfolio (Meta blocks sensitive actions without it).
4. **Display name** for the platform's own number (the shared number, if used): must match the brand on the website; Meta rejects the word "WhatsApp" in names (help: `docs/help/*/01-verify-your-business-on-meta.md`).

## 2. Meta app (Ahmad, with Claude preparing the texts)
1. App "Ebda AI Studio" (type Business) owned by the verified portfolio. App ID → secret `META_APP_ID`; app secret → `META_APP_SECRET`.
2. Products: **WhatsApp** and **Facebook Login for Business**.
3. **App review** (Advanced Access): `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management`, `catalog_management` (creating and connecting the merchant's product catalog; also tick it in the Embedded Signup configuration, otherwise the Bot screen says "reconnect to grant catalog access"). Each needs a screen recording of the real flow (connect a number with Embedded Signup, send a template, receive a reply). Claude writes the use-case texts; Ahmad records and submits.
4. **Tech Provider** onboarding in the WhatsApp product (needed before other businesses can connect their numbers).
5. **Embedded Signup configuration**: Facebook Login for Business → Configurations → create one for WhatsApp Embedded Signup. **Use v4 or later**: v2/v3 were deprecated on 2026-10-15. On v4+ the version comes from the configuration and the page passes only `extras: { setup: {} }`; on v5 onboarding an existing WhatsApp Business app number (coexistence) is on by default, which is what most merchants without a spare number need. Configuration ID → `EMBEDDED_SIGNUP_CONFIG_ID` (public, used by the web page).
6. **Webhook**: callback `https://<host>/meta/webhook`, verify token = secret `META_VERIFY_TOKEN`; subscribe fields `messages`, `message_template_status_update`, `phone_number_quality_update`, `account_update`, and for coexistence `history`, `smb_app_state_sync`, `smb_message_echoes`.
7. **System user** in the portfolio with the app assigned → long-lived token → `META_SYSTEM_TOKEN` (platform-level calls and the shared number). Merchants' own numbers use their own business token from Embedded Signup, stored encrypted per WhatsApp Business Account.

## 3. Payments (Ahmad)
1. **Kashier** merchant account for Ebda AI Studio (top-ups). Keys go into the `KASHIER_*` secrets listed in `docs/billing.md`; webhook URL from the same doc.
2. Decide and publish the open billing items: VAT presentation (Q5, after VAT/e-invoice registration), FX buffer (Q6), and the refund terms text (WA-REFUND-1) checked by a lawyer.

## 4. Legal pages (Ahmad approves, Claude drafts)
Privacy policy, terms of service (incl. refund terms), and a **data deletion** URL/instructions page. Meta's app review requires the privacy policy URL and the data deletion URL. They live on the Store's public site (help.ebda.app / ebda.app).

## 5. Ebda Store side (Store session)
The `WhatsAppBridge` RPC entrypoint, the `ebda-wa-events` / `ebda-store-events` queues and `store.plan_changed` on every plan write, per the accepted contract (`business/ebda/plans/2026-10-24-ebda-whatsapp-store-contract.md`). Until then the store link stays off and the inbox works without it.

## 6. Cloudflare resources (Claude, on the personal account `69188202efc4df480140dd76545aa3ab` only)
Check `npx wrangler whoami` first; never deploy to any other account.
`bash scripts/cf-resources.sh` lists what exists and prints what is missing (dry run, creates nothing); `--apply` creates the missing ones after the launch go. Applied 2026-10-25 on the coordinator's go: `ebda-wa-backups` (+ `expire-30d` lifecycle), queues `ebda-wa-events` (+dlq) and `ebda-store-events`, Vectorize `ebda-wa-kb` created; the re-run reports 0 missing. Their bindings (Vectorize, Store-link queues) stay commented in `wrangler.jsonc` until the deploy that uses them.
| Resource | Command / place | Binding |
|---|---|---|
| R2 backups + 30-day lifecycle | `npx wrangler r2 bucket create ebda-wa-backups` · `npx wrangler r2 bucket lifecycle add ebda-wa-backups expire-30d --expire-days 30` | `BACKUPS` |
| R2 logs + Logpush (Ahmad clicks) | `docs/runbooks/cloudflare-account.md` § Logs | n/a |
| Vectorize index (AI knowledge base) | `npx wrangler vectorize create ebda-wa-kb --dimensions=<model dims> --metric=cosine`, then uncomment the binding | `VECTORIZE` |
| Store events queues | `npx wrangler queues create ebda-wa-events` (+ `-dlq`), `ebda-store-events`; uncomment bindings | `STORE_EVENTS`, consumer |
| Store service binding | uncomment once the Store Worker exists | `STORE_BRIDGE` |
| Accounts revocation binding | uncomment the `services` line in `wrangler.jsonc` once `ebda-accounts` (entrypoint `Accounts`, RPC `isRevoked(sid)`) is deployed; top-ups and operator writes answer 503 until then | `ACCOUNTS` |
| Billing alerts (Ahmad clicks) | `docs/runbooks/cloudflare-account.md` § Billing alerts | n/a |

## 7. Secrets (Ahmad pastes values, Claude runs the commands)
One session, Worker `ebda-wa` only: `npx wrangler secret put <NAME>` for each; values never go into chat, git or command-line arguments.
Generate random keys locally: `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`.

| Secret (Worker `ebda-wa`) | Value comes from | Needed for |
|---|---|---|
| `META_APP_SECRET` | Meta app → Settings → Basic | webhook signatures (required) |
| `META_VERIFY_TOKEN` | any random string, also typed into Meta's webhook setup | webhook handshake (required) |
| `META_SYSTEM_TOKEN` | Meta Business → System user token | platform calls, shared number (required) |
| `TOKEN_ENC_KEY` | random 32 bytes, base64 | own numbers (encrypts each business token) |
| `AGENT_SECRETS_KEY` | random 32 bytes, base64 | AI agent (encrypts merchants' own model keys) |
| `SUITE_BUYER_KEY_SECRET` | **the same value as Ebda Store's** (set on both Workers in the same session) | store link (buyer keys) |
| `PROOF_URL_SECRET` | random 32 bytes, base64 | store link (signed proof links) |
| `KASHIER_API_KEY` | Kashier dashboard (Payment API Key) | top-ups and package checkout; webhook HMAC |
| `KASHIER_SECRET_KEY` | Kashier dashboard (the **Secret key**, a different key) | confirms every webhook with Kashier's transaction-details API before money moves; without it webhooks answer 503 |
| `EBDA_INSTAPAY_HANDLE` | **the same value as `ebda-api`** (Ebda Store's InstaPay address; set on both Workers in the same session) | InstaPay billing: who merchants pay (unset = InstaPay billing is unavailable, 503) |
| `SENTRY_DSN` | Sentry project | error reports |

**Self-check:** `/health` answers `503 {status: "misconfigured"}` while any secret named in the `REQUIRED_SECRETS` var (`TOKEN_ENC_KEY`, `AGENT_SECRETS_KEY`, `PROOF_URL_SECRET`, `SUITE_BUYER_KEY_SECRET`) is missing, or any of them is set but malformed (the two AES keys must decode to exactly 32 bytes, so a 64-character hex string fails; the other two need at least 32 characters). The Worker log names the key (alert `secret_misconfigured`, never the value); `scripts/verify-prod.mjs` reports it. Section C secrets (Meta, Kashier) are not in the list: their features stay off until they are set.

Plain vars, not secrets (set in `wrangler.jsonc` or the dashboard): `EBDA_INSTAPAY_QR_URL` (same as ebda-api; Store's value is `https://media.ebda.app/platform/instapay-qr.jpg`, https only), `EBDA_INSTAPAY_PAYEE_NAME` (optional; defaults to the studio name), `META_APP_ID`, `EMBEDDED_SIGNUP_CONFIG_ID`, `KASHIER_MERCHANT_ID`, `KASHIER_API_URL` (default `https://api.kashier.io`), `KASHIER_FEE_BPS`, `KASHIER_FEE_FIXED_MINOR`, `ADJUSTMENT_APPROVAL_MINOR`, `ADJUSTMENT_DAILY_CAP`, and the switches in §8. `IDENTITY_OIDC_CONFIG` is only for white-label tenants on their own identity provider (`deploy/white-label`).

## 8. Switches (Claude, one at a time, each verified before the next)
`EMBEDDED_SIGNUP_ENABLED` → `SHARED_NUMBER_ENABLED` → `INSTAPAY_BILLING_ENABLED` (the launch payment method until Kashier is approved; needs `EBDA_INSTAPAY_HANDLE` and the operator review duty below) → `TOPUPS_ENABLED` → `PACKAGE_CHECKOUT_ENABLED` (both stay off until Kashier is approved) → `KASHIER_REFUNDS_ENABLED` (last, after the first-real-refund check in section 13). Each stays off until the Meta/Kashier step it depends on is done. `PACKAGE_CHECKOUT_ENABLED` (self-serve package purchase) needs the same Kashier steps as top-ups: set `KASHIER_MERCHANT_ID` + `KASHIER_API_KEY` + `KASHIER_SECRET_KEY`, point the Kashier webhook at `/kashier/webhook` (one webhook serves both kinds), bind `ACCOUNTS`, apply D1 migration `0008_packages.sql` first (it seeds the `store-included` package and marks existing subscription rows operator-owned), and insert the sellable `packages` rows (`price_minor`, `ai_credits`, `active = 1`). Verify with a real small payment before announcing. `SHARED_NUMBER_ENABLED` also needs D1 migration `0013_shared_templates.sql` applied and, after registering the platform number, one "Sync from Meta" in the operator console's Shared number templates tab: until the catalog is synced, no template can be sent from the shared number (marketing never can).

### InstaPay review duty (operator, while `INSTAPAY_BILLING_ENABLED` is on)
Every InstaPay payment waits for a person: an operator opens **Operator -> Queues -> InstaPay transfers**, views the proof (a signed link that works for 2 minutes), checks the amount and the reference against the bank app, and confirms or rejects with a reason the merchant reads. **SLA: review within 4 business hours (Sunday to Thursday, 09:00-17:00 Africa/Cairo).** A proof that waits longer raises `instapay_proof_overdue` (P1) once. The person who made the request never reviews it; at or above `ADJUSTMENT_APPROVAL_MINOR` two different operators must confirm. A request with no proof expires after 48 hours (daily pass); a proof already uploaded never expires on the clock. Rejection tells the merchant in the Wallet screen (the reason is shown); there is no WhatsApp notification yet because no suitable utility template exists (a template needs Meta approval first).

`INTEGRATOR_TOKENS_ENABLED` (default off; `1` or `true`) lets a merchant's own server call the API with a scoped client token from the sign-in service (identity contract v1.3, DRAFT r2: do not switch it on before the accounts owner has approved the contract and shipped `POST /oauth/token`, the client table and `Accounts.isRevoked` for `cli_` ids). While it is off, any token with `client: true` or role `integration` is 401. When on: the `ACCOUNTS` binding must be bound (every integration request checks it and fails closed with 503; a 30 s per-isolate cache of an "ok" answer is the only staleness). The scope map is `src/core/identity/scopes.ts`; every write by a server token logs `integration_write { clientId, jti, storeId, scope }`.

## 9. CI back on (Ahmad decides, Claude sets up)
CI is paused by Ahmad's instruction. To resume: bring the Umbra runner for this repo online, set repo variable `EBDA_RUNS_ON` to `["self-hosted","umbra-ebda"]` (JSON), and confirm the remote Actions cache stays off on the self-hosted runner. Branch protection: require `ci` + `gitleaks` on `main`.

## 10. Merge order (Claude, after Ahmad's go)
1. `feat/phase4-7` → `main` in one PR: it already carries Phases 4-9 (store link, AI agent, campaigns, billing and its screens, own numbers, shared number, operator console, connectors, brand packs, white-label kit) and the final whole-branch review fixes.
2. Launch is joint with Ebda Store (LAUNCH-SUITE-1): accounts.ebda.app live first, then this deploy; the Store session holds the launch gate.
Each merge: full suite green twice locally, CI green, then deploy.

## 11. Migrations (Claude)
`npx wrangler d1 migrations apply ebda-wa-platform --remote` before the deploy that needs them. Durable Object SQLite migrates itself on first access (versioned in code).

## 12. Deploy (Claude)
`npx wrangler deploy --var COMMIT_SHA:$(git rev-parse --short HEAD)` from a clean checkout of `main` (so `/health` reports the commit).

## 13. Verify production (Claude) — after EVERY deploy
```
META_VERIFY_TOKEN=… META_APP_SECRET=… node scripts/verify-prod.mjs --base https://wa.ebda.app --expect "$(git rev-parse --short origin/main)" --brand ebda
```
It checks the running commit, the security headers on the API and the page, Meta's webhook handshake, that unsigned/badly-signed webhooks are refused, and that a correctly signed empty webhook is accepted. Anything it could not check prints as SKIP and must be reported as not verified. Then, by hand:
0. **Live identity round trip** (the first deploy only proves it): Ahmad signs in at `https://wa.ebda.app`; the inbox loads his store, which proves a real accounts.ebda.app token (ES256, `iss` https://accounts.ebda.app, `aud` whatsapp, `stores[]`) passes our verifier. A 401/403 loop here = stop and report, do not continue.
1. Send a WhatsApp message to the connected number from the owner's phone; it appears in the inbox in real time; reply from the inbox; the owner receives it.
2. Open the inbox in Arabic and English, on a phone and a desktop.
3. For the shared number / top-ups: a top-up of the minimum amount with a real card, then the statement shows it (Ahmad approves the payment first).
4. **First real refund** (only once `KASHIER_REFUNDS_ENABLED` is on; leave it off until Kashier is live): refund the smallest card top-up through an approved request, then **verify the live response shape**: the `card_refunds` row must end `succeeded` with Kashier's refund id, `refunded_minor` must move by exactly that amount, the wallet must show ONE `refund` row and no `chargeback` row after Kashier's refund webhook, and Kashier's dashboard must show the refund. If the row ends `uncertain` or the webhook books a `chargeback`, switch the flag off and read `docs/billing.md` (Card refunds). Also confirm the refund webhook carries our merchant order id and the refund's own transaction id, and **verify that the refund id in the API answer (R) equals the webhook's `transactionId` (W)** before leaving the switch on: if they differ, the webhook is held (`refund_held`, P1) instead of debiting, and an operator must match it.

### Request guards (security, `src/core/request-guards.ts`, one middleware before every route)
- Body size is checked before the body is read (`Content-Length`) and counted while it is read (chunked, no length): `/meta/webhook` and `/kashier/webhook` 256 KB, JSON API 1 MB, uploads keep their own limits (media 50 MB, imports 10 MB, InstaPay proof 5 MB, plus the multipart envelope). Over: `413 {"error":"payload_too_large"}`.
- Content-type allow-list when a body is present: webhooks and API writes `application/json`; media and imports `multipart/form-data`; the InstaPay proof jpeg/png/webp/pdf. Anything else: `415 {"error":"unsupported_media"}`.
- Public-route limits, token buckets in the isolate (the Workers Rate Limiting binding is not configured): `/t/:code` 200/s (burst 500) per workspace; `/meta/webhook` 50/s (burst 200) per `phone_number_id`, counted only for requests with a VALID signature (a forged body cannot spend another number's allowance). Over: `429 {"error":"rate_limited"}` with `Retry-After`. Staleness class BOUNDED-stale: per isolate, resets on eviction, several isolates each hold a bucket; the limits sit far above real traffic and guard no money or permission. Residual: Meta and Kashier redeliver a 429 with backoff, so a signed event over the limit is delayed, not lost; a number that keeps exceeding the limit keeps being delayed.
- `/t/:code` already answers a malformed code or an unknown workspace with 404 before any Durable Object is woken; after deploy check that a made-up code returns 404 and a normal webhook and API call still pass.

## 14. Go live checklist for the first merchant
Business verified · number connected and registered (or coexistence synced within 24 h) · templates approved · store linked (if Ebda Store) · AI agent configured (optional) · wallet funded (shared number only) · help guides published at help.ebda.app.
