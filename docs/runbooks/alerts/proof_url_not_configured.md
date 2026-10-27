# proof_url_not_configured (P1)
**Severity:** P1 look today
## What it means
In the ordering bot (src/core/ordering/bot.ts) a buyer sent an InstaPay payment screenshot, but the signed proof link could not be built because `PROOF_URL_SECRET` or `PUBLIC_BASE_URL` is unset. The alert field is `workspace`.
## Impact
The receipt is not forwarded to the Store. The bot turn fails (it throws "payment screenshot links are not configured") and is retried. The buyer's payment proof is stuck until the config is fixed. No money is moved by this alert.
## Check first
1. Search logs for `{"alert":"proof_url_not_configured"`.
2. Check that the Worker has the secret `PROOF_URL_SECRET` and the var `PUBLIC_BASE_URL` (docs/store-link.md, "Switching it on" table). Use `npx wrangler secret list` to see secret names only.
3. Check `PUBLIC_BASE_URL` in wrangler config for the target environment.
## Fix
1. Set the missing secret with `npx wrangler secret put PROOF_URL_SECRET` (never print or paste its value in chat or tickets) or add the var `PUBLIC_BASE_URL` and deploy.
2. The turn is retried by the system; no manual replay is documented. Not documented in code: ask the engineer on call if a buyer is still stuck after the fix.
## Verify it is resolved
No new `proof_url_not_configured` lines after the deploy, and the next InstaPay screenshot reaches the Store.
## Related
docs/store-link.md ("Switching it on"), docs/billing.md (InstaPay billing), alert: secret_misconfigured
