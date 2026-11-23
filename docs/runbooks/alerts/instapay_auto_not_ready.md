# instapay_auto_not_ready (P1)
**Severity:** P1 look today
## What it means
Fires from the daily pass (`checkAutoReadiness`, src/core/billing/instapay-auto.ts) when the InstaPay auto-confirm mode is `shadow` or `live` but `instapayAutoReady` says something is missing. Field `missing` lists it: `INSTAPAY_DEDUPE_DB` (the shared duplicate-index D1), `INSTAPAY_BRIDGE_SECRET`, `BRAIN_BRIDGE_URL`, `INSTAPAY_PAYEE_HANDLE`, `AI`. Mode `off` never fires this.
## Impact
Auto-confirm refuses every payment (fail closed), so every InstaPay top-up and package still waits for an operator. No money is lost.
## Check first
1. `curl https://wa.ebda.app/health`: `instapayAuto.missing`.
2. `GET /api/v1/operator/instapay/auto`: `mode` and `ready`.
## Fix
1. Create the D1 `ebda-instapay-dedupe`, apply the dedupe schema and bind it as `INSTAPAY_DEDUPE_DB` (docs/rulings/INSTAPAY-AUTO-1.md, ruling 1.10).
2. `wrangler secret put INSTAPAY_BRIDGE_SECRET` with the SAME value as the brain's `INSTAPAY_BRIDGE_SECRET_CHAT`; set `BRAIN_BRIDGE_URL` to the brain's `/api/instapay/notify` https URL.
3. Or put the mode back to `off` with a reason (`PUT /api/v1/operator/instapay/auto/mode`) until the setup is done.
## Verify it is resolved
`/health` shows `instapayAuto.ready: true` and the alert stops on the next daily pass.
## Related
docs/billing.md (InstaPay auto-confirm); docs/rulings/INSTAPAY-AUTO-1.md; alerts: instapay_auto_digest_stale
