# signup_not_configured (P1)
**Severity:** P1 look today
## What it means
Fires in src/routes/numbers.ts when Embedded Signup is switched on but a required key is missing or malformed. Field: `missing` lists key NAMES only (never values), for example META_APP_ID, EMBEDDED_SIGNUP_CONFIG_ID, META_APP_SECRET, TOKEN_ENC_KEY. The caller gets 503 `signup_unavailable`.
## Impact
Merchants cannot connect a WhatsApp number. Existing connected numbers keep working. No money is wrong.
## Check first
1. Search logs for `{"alert":"signup_not_configured"...}` and read `missing`.
2. Confirm which of those keys are set for the environment (names only): `npx wrangler secret list`. Do not print values.
3. Read docs/numbers.md, the Embedded Signup section.
## Fix
1. Set each missing key with `npx wrangler secret put <NAME>` (EMBEDDED_SIGNUP_CONFIG_ID may be a plain var in the wrangler config: Not documented in code, ask the engineer on call). Values come from the Meta app; ask Ahmad.
2. A TOKEN_ENC_KEY that is "malformed" must decode to 32 bytes. Never rotate it without the engineer on call: it encrypts stored tokens.
3. This does not repair itself; the next request after the fix works.
## Verify it is resolved
`GET /api/v1/stores/:storeId/numbers/signup-config` no longer answers 503 and the alert stops.
## Related
docs/numbers.md; docs/runbooks/alerts.md (secret_misconfigured)
