# First live contact checklist (M-059)

Everything below is covered by tests against **stubs of the documented shapes**. None of it has talked to the real service yet. This file lists
what to look at on the **first real contact** with each service, what "good" looks like, and where the answer is recorded. A box stays empty until
someone has seen the evidence; "it deployed" is not evidence (rule F: a merge is not a deploy, a deploy is not a working feature).

How to use it: do the contact with a test number / test card only, copy the observed value into the **Observed** column, set the date and who
saw it, and if reality differs from "Expected", write a `Ruling` under the table and fix the code or the doc in the same change. Never paste a
token, a secret, a card number or a customer's phone here: ids of objects (waba id, order id) and status words only.

Preconditions for every section: `node scripts/verify-prod.mjs --base https://<host> --expect <tip of main>` ends `VERIFIED` and its `SKIP` lines
are understood (docs/runbooks/rollback.md); the Worker secrets named in `docs/launch/README.md` section 7 are set; `wrangler whoami` shows the personal account.

## 1. Meta Graph API (messaging)

Run with the Meta test number first, then once with a real merchant number.

| # | What to check | Expected | Observed | Date / by |
|---|---|---|---|---|
| G1 | `GET /meta/webhook` handshake from Meta's dashboard ("Verify and save") | 200 with the challenge; the dashboard shows the callback verified | | |
| G2 | One inbound text from a phone to the test number | `POST /meta/webhook` 200, message in the inbox, Arabic and emoji byte-exact | | |
| G3 | One outbound text reply inside the 24 h window | Graph answers `messages[0].id`; status events `sent`, `delivered`, `read` arrive and the message ends `read` | | |
| G4 | One template send (utility) outside the window | Accepted; the status webhook carries the `pricing` object (category) and the wallet debit equals the rate card for that category | | |
| G5 | Meta's pricing object vs our rate table (`docs/billing.md`, versioned rates) | Same category and same currency basis; any difference is a Ruling and a rate-card version | | |
| G6 | `phone_number_quality_update` and `account_update` webhooks (Meta's "Send test" button) | Number health row written, alert only above green (`docs/number-health.md`) | | |
| G7 | Error mapping: send to a number not on WhatsApp | The documented code (131026) maps to `undeliverable`, no retry storm | | |
| G8 | Media: inbound image and an outbound image upload | Inbound stored in R2 with the real MIME; outbound upload returns a media id and the byte sniff accepts it | | |
| G9 | Graph version pin (`META_GRAPH_VERSION` in `wrangler.jsonc`) | The version still answers; Meta's changelog has no removal dated before the next review | | |

## 2. Embedded Signup (connect a merchant's own number)

Needs the verified Meta business, Tech Provider status and a v4+ Login configuration (`docs/launch/README.md` sections 1 and 2). Use a spare number.

| # | What to check | Expected | Observed | Date / by |
|---|---|---|---|---|
| E1 | Browser: `FB.login` opens with the configuration id; the window message arrives | `WA_EMBEDDED_SIGNUP` with `event`, `phone_number_id`, `waba_id` (and `business_id`) | | |
| E2 | `POST /numbers/connect` right after the popup | 200 inside the 30 s code lifetime; the number is `active`; the token is stored encrypted (never returned by `GET /numbers`) | | |
| E3 | `GET /<WABA>/phone_numbers` contains the claimed number | Yes; otherwise the connect must refuse (`docs/numbers.md`) | | |
| E4 | `POST /<WABA>/subscribed_apps` | Succeeds; one inbound message to the new number reaches the inbox | | |
| E5 | New number (`FINISH`): `/register` with the generated PIN | Registered; `133016` (10 attempts / 72 h) is handled as `registration_locked` and was NOT provoked on purpose | | |
| E6 | Business app number (coexistence, `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) | No `/register`; contacts and history sync requests accepted; the `history` and `smb_*` webhooks arrive | | |
| E7 | `business_id` reported by the browser vs `owned_whatsapp_business_accounts` | Listed, so stored; otherwise the `business_id_unverified` alert fired and the connect still worked | | |
| E8 | Disconnect, then reconnect the same number | Clean; no orphan subscription; billing records `merchant_card` funding once (idempotent) | | |

## 3. Kashier (card top-ups, package checkout, refunds)

Kashier **test** mode first (`KASHIER_API_URL` pinned to a `kashier.io` host), then one real small payment. Money-touching: the operator who does it
writes the order id and amount here; completing a real purchase is Ahmad's click.

| # | What to check | Expected | Observed | Date / by |
|---|---|---|---|---|
| K1 | Create a top-up: `POST /wallet/topups` returns a hosted checkout URL | URL on a Kashier host; a pending `topups` row | | |
| K2 | Pay it with a test card | Webhook `POST /kashier/webhook` verified by the HMAC over `signatureKeys` AND by the transaction-details call; the wallet is credited exactly the requested amount, not the fee | | |
| K3 | Which fields `signatureKeys` really contains | Includes amount, currency, merchantOrderId, status, transactionId (we require all five) | | |
| K4 | Replay the same webhook | 200, no second credit (`duplicate_success` P0 stays silent) | | |
| K5 | A failed payment | `webhook_unconfirmed` or a FAILURE row, no credit | | |
| K6 | Package checkout (monthly) and, once, yearly | Entitlement pushed to the workspace and to the Store; how long the checkout session stays payable (docs/billing.md residual) written here | | |
| K7 | Refund via API (`KASHIER_REFUNDS_ENABLED`) on the test payment | Response shape matches `docs/billing.md` (`PENDING` / `SUCCESS`); the refund webhook payload recorded here; refund rows carry the original merchant order id | | |
| K8 | Kashier's per-transaction refund cap | The number is written here; a larger refund is split by the operator | | |
| K9 | The `KASHIER_SECRET_KEY` details call from the Worker's egress | Answers 200 for a real transaction (otherwise every webhook answers 503 and no payment is ever credited) | | |

## 4. When something differs

Write `Ruling FLC-<n> - <what differed>. <evidence>. Cost if wrong: <one sentence>.` below this line, fix the code or the doc in the same change,
add the case to the stubbed test so the real shape is what the tests now pin, and tick the row.
