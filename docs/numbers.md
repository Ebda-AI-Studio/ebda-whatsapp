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
   4. Stores the token encrypted per WABA (`waba_credentials`) and the number row (`phone_numbers`, `kind = own`), still `disconnected`.
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

## Not verified against real Meta
Every Graph call is covered with stubs of the documented shapes. Nothing here has talked to Meta yet.
