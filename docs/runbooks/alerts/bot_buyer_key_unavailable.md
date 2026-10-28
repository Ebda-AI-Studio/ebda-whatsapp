# bot_buyer_key_unavailable (P1)
**Severity:** P1 look today
## What it means
The ordering bot (src/core/ordering/bot.ts, `buyerOf`) could not compute the buyer key for a chat. Fields: `workspace` and `why`: `no_secret` means `SUITE_BUYER_KEY_SECRET` is unset, `bad_number` means the sender number is not valid E.164.
## Impact
The buyer cannot place or look up orders in chat for that turn. With `no_secret` every buyer of every workspace is affected. Money and consent are not changed.
## Check first
1. Search logs for `{"alert":"bot_buyer_key_unavailable"` and read `why`.
2. If `no_secret`: check the secret name `SUITE_BUYER_KEY_SECRET` exists (`npx wrangler secret list` shows names only). Also see /health and the alert secret_misconfigured.
3. If `bad_number`: usually one odd sender; check whether it repeats for the same workspace.
## Fix
1. `no_secret`: set it with `npx wrangler secret put SUITE_BUYER_KEY_SECRET` (value must match the Store's; never print it) and redeploy if needed.
2. `bad_number`: no action unless it repeats; Not documented in code: ask the engineer on call.
## Verify it is resolved
No new alert lines, and a test order from a valid number reaches the Store.
## Related
docs/store-link.md ("Switching it on" table), alert: secret_misconfigured
