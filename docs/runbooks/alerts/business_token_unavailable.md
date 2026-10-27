# business_token_unavailable (P1)
**Severity:** P1 look today
## What it means
Fires from `sendToMeta` (src/core/send-queue.ts) when the merchant's own WhatsApp business token cannot be read for a send (`TokenUnavailable` from src/core/numbers/token.ts). Fields: `workspace`, `reason`: `no_key` (the encryption key is missing from the Worker), `no_credential` (no stored token for the WABA), `unreadable` (stored token cannot be decrypted).
## Impact
Sends from that merchant's number fail (not retried, message `token_unavailable`). No money or consent issue; deliveries stop until the connection is fixed.
## Check first
1. Search logs for `{"alert":"business_token_unavailable"` and note `workspace` and `reason`.
2. If many workspaces show `no_key`, check that the Worker secret `TOKEN_ENC_KEY` exists: `npx wrangler secret list` (names only; never print values). Also see `secret_misconfigured` and `/health`.
3. For one workspace, read `waba_credentials` and `phone_numbers` in D1; `GET /api/v1/stores/:storeId/numbers` shows the number state to the merchant.
4. Read docs/numbers.md (business token).
## Fix
1. `no_credential` or `unreadable` for one workspace: ask the merchant to reconnect the number (disconnect and connect again from the app).
2. `no_key` for many: restore the secret with `wrangler secret put TOKEN_ENC_KEY`. Do NOT generate a new key for existing tokens (they would become unreadable): ask the engineer on call.
## Verify it is resolved
New sends from that number reach Meta and the alert stops.
## Related
docs/numbers.md; docs/runbooks/alerts.md (send_dlq, secret_misconfigured)
