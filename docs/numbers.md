# Connecting a merchant's own number (Phase 8.1)

Switch: `EMBEDDED_SIGNUP_ENABLED` (`1` or `true`). Off or unset, every `/api/v1/stores/:storeId/numbers*` route answers 404. Verified against Meta's documentation on 2026-10-25; Embedded Signup v2 and v3 were retired on 2026-10-15, so v4 and later (driven by the Login configuration) is assumed.

## Secrets and switches
| Key | Kind | Notes |
|---|---|---|
| `EMBEDDED_SIGNUP_ENABLED` | var | the switch |
| `META_APP_ID` | var or secret | the app id used to exchange the code |
| `META_APP_SECRET` | secret | already used for webhook signatures; also the `client_secret` of the exchange |
| `TOKEN_ENC_KEY` | secret | base64 of 32 random bytes. Encrypts business tokens and registration PINs (AES-GCM, the workspace id is the associated data, so a value copied into another workspace does not open) |
| `META_SYSTEM_TOKEN` | secret | the platform token. Still used for the shared number and platform-level calls |
| `SHARED_NUMBER_ENABLED` | var | the switch of the shared platform number; see `shared-number.md` (the platform number is not a `phone_numbers` row) |
| `META_GRAPH_VERSION` | var | latest is v26.0 |

With the switch on and a key missing or malformed, a request answers `503 signup_unavailable` (`signup_not_configured`) and logs one `signup_not_configured` alert naming the missing keys (never values).

The Meta app dashboard must subscribe the app-level webhook fields `messages`, `message_template_status_update`, `phone_number_quality_update`, `phone_number_name_update`, `account_update`, `history`, `smb_app_state_sync` and `smb_message_echoes`. `POST /<WABA>/subscribed_apps` only attaches each WABA to the app.

## The flow
1. The browser opens Embedded Signup (`FB.login` with the Login configuration id; the `extras` object carries only `setup: {}`). It listens for the window message `data.type === 'WA_EMBEDDED_SIGNUP'` and reads `event`, `phone_number_id`, `waba_id`, `business_id`:
   - `FINISH`: a new number on the Cloud API.
   - `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`: a number that stays on the WhatsApp Business app (coexistence). This is the default path we recommend.
   - `FINISH_ONLY_WABA`, `CANCEL` (`current_step`), `ERROR` (`error_message`) never reach the API.
2. `POST /api/v1/stores/:storeId/numbers/connect` with `{ code, event, wabaId, phoneNumberId, businessId? }` (owner only).
3. The server, in this order:
   1. Refuses (409 `number_conflict`) a number or WABA that belongs to another workspace. Only fast D1 reads happen before the exchange: **the code lives 30 seconds**.
   2. Exchanges the code: `GET /<v>/oauth/access_token?client_id&client_secret&code` returns the business token. There is no second long-lived exchange (that is for user tokens).
   3. Reads `GET /<WABA>/phone_numbers` with the new token and requires the claimed number in it. The token's own access is the authority for the ids the browser sent; nothing is stored before this passes.
   4. Stores the token encrypted per WABA (`waba_credentials`, with the `business_id` the browser reported only if `GET /{business_id}/owned_whatsapp_business_accounts` (merchant token) lists this WABA, else NULL and an `business_id_unverified` alert, the connect never fails on it; kept on a reconnect that omits it; used to create the merchant's catalog, see `store-link.md`) and the number row (`phone_numbers`, `kind = own`), still `disconnected`.
   5. `POST /<WABA>/subscribed_apps`. A failure is a hard, retryable failure (`503 signup_unavailable`): a number without webhooks is deaf.
   6. `FINISH`: registers with a PIN (see below). `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`: no `/register`; requests the two one-time syncs.
   7. Marks the number `active`, pulls status (name, quality, tier, throughput) and calls `onNumberConnected` (billing records `merchant_card` funding there, Ruling WA-FUND-1; it must be idempotent because completing a half-finished connect calls it again).
4. Every later step is resumable without a new code: `POST /numbers/:phoneNumberId/register` repeats whatever is open (subscription, registration, syncs).

Other routes: `GET /numbers` (owner and staff; never returns tokens or PINs), `POST /numbers/:id/refresh` (owner and staff), `POST /numbers/:id/register` (owner), `POST /numbers/:id/disconnect` (owner). Responses carry a `numberDto` (see `src/core/api/contract.ts`), with `warnings` when a best-effort Meta call failed.

## PIN and lockout
For a new number the server generates a 6-digit PIN with `crypto.getRandomValues` (uniform, no modulo bias), stores it encrypted **before** calling Meta, and registers with it. A retry reuses the stored PIN. Meta error `133016` means 10 attempts in 72 hours: the number is `locked`, the answer is `429 registration_locked`, and nothing is retried until the window passes.

## Coexistence (a number kept on the WhatsApp Business app)
- After onboarding the server asks for the contacts sync (`sync_type: smb_app_state_sync`) and the history sync (`sync_type: history`) via `POST /<PN>/smb_app_data`. **Each can be requested once, within 24 hours of onboarding**; later the merchant must redo the signup. A refusal is shown (`contactsSync` / `historySync` = `refused`), not thrown. `syncDeadlineAt` in the DTO is the 24 h limit.
- Throughput of such a number is fixed by Meta at 20 messages per second; the send throttle uses it.
- Webhooks: `smb_message_echoes` (what the merchant typed in the app) is stored as an outgoing message with author `app`, never sent; `smb_app_state_sync` contacts are saved with no marketing consent; `history` is stored in its conversations with the original timestamps. History never opens a 24 h window, raises unread, wakes the bot or agent, or sends an auto reply. Declining the history share arrives as error `2593109` and shows as `historySync = declined`.
- History media (placeholders) is not downloaded.

## Token resolver and cache
`graphTokenFor(env, { wabaId } | { phoneNumberId })` (`src/core/numbers/token.ts`) returns the decrypted business token for a merchant's own number and `META_SYSTEM_TOKEN` otherwise. Sends, media upload and download, templates and the catalog all use it. An own number whose credential is missing or unreadable fails with `token_unavailable` and never borrows the platform token.

Cache staleness class: **BOUNDED-stale, 60 s per isolate**, cleared synchronously on connect and disconnect in the writing isolate. Residual: up to 60 s elsewhere of sends with a revoked token (Meta rejects them; the existing retry pipeline handles it).

## Disconnect
Marks the number `disconnected` first (sending stops), then best effort: `POST /<PN>/deregister` for Cloud API numbers (not for Business app numbers), and, when no other active own number uses the WABA, `DELETE /<WABA>/subscribed_apps` and deletion of the credential. Failures come back as warnings.

## Health
Each number carries a health state (green / yellow / red / restricted) from Meta's quality and account webhooks; see `docs/number-health.md`. `GET /numbers` returns it as `health`; the Numbers screen shows a badge and one sentence when it is not green.

## Not verified against real Meta
Every Graph call is covered with stubs of the documented shapes. Nothing here has talked to Meta yet.

## In the page (Phase 8.4)
- `GET /me` → `capabilities.numbers` tells the page whether connecting numbers is open (`EMBEDDED_SIGNUP_ENABLED`); the "WhatsApp number" screen appears only then.
- `GET /numbers/signup-config` (owner) returns the public Meta ids the popup needs: `appId` (`META_APP_ID`), `configId` (`EMBEDDED_SIGNUP_CONFIG_ID`, the Facebook Login for Business configuration, v4+) and `graphVersion`. Missing ids → 503 `signup_unavailable` with a one-line alert.
- `web/src/lib/embedded-signup.ts` loads Meta's SDK, calls `FB.login` with `{ config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {} } }`, accepts the `WA_EMBEDDED_SIGNUP` message only from `https://facebook.com` or a `*.facebook.com` host (a suffix check would also accept `notfacebook.com`), and posts code + ids to `/numbers/connect` at once (30-second code). The screen fetches the config and loads the SDK when it opens, so the click calls `FB.login` with nothing awaited before it (a popup opened after an await is blocked). A code with no session message ends in an error after 25 s (the code lives 30 s); an SDK that does not load in 15 s is `sdk_unavailable`; a popup closed after FINISH with no code reports an error, closed with nothing done reports a cancel.
- The page's CSP allows `https://connect.facebook.net` scripts and `https://*.facebook.com` frames/calls (`web/brands/<brand>/public/_headers`, one per brand). Not yet verified against Meta's live SDK: that needs the real app and configuration (launch kit step 2).
- The screen also shows a getting-started checklist (number, an approved template, the Store link, the AI agent) linking to the guides on help.ebda.app (`/ar/<slug>` or `/en/<slug>` by interface language).
