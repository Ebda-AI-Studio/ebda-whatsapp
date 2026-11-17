# instapay_auto_digest_stale (P1)
**Severity:** P1 look today
## What it means
Fires from `runInstapayDigest` (src/core/billing/instapay-notify.ts) when the oldest auto-confirmed InstaPay payment that is not yet listed in a SENT digest is older than 26 hours. Field: `oldestAgeHours`. The daily digest goes to the platform owner through the OS brain; a payment counts as clean (no first-payment cap on the merchant's next payment) only after a digest that really listed it was sent.
## Impact
Nobody has had the chance to tap "not received" on those payments, and the merchants' next large payments keep waiting for a person. No money is lost by the alert itself.
## Check first
1. `GET /api/v1/operator/instapay/auto?state=auto_confirmed`: rows with `digestSentAt` empty.
2. Is `BRAIN_BRIDGE_URL` reachable and `INSTAPAY_BRIDGE_SECRET` the same value as the brain's `INSTAPAY_BRIDGE_SECRET_CHAT`? `/health` shows `instapayAuto.ready`.
3. The brain allows ONE digest per product per UTC day and 200 items per digest: more than 200 waiting drain over several days.
## Fix
1. Fix the bridge secret or URL; the next daily pass resends everything not stamped.
2. If the brain is down, wait for it: nothing is lost, rows are only stamped after a confirmed send.
3. To stop new automatic payments meanwhile: `PUT /api/v1/operator/instapay/auto/mode` with `off` and a reason.
## Verify it is resolved
The rows show `digestSentAt` and the alert stops on the next daily pass.
## Related
docs/billing.md (InstaPay auto-confirm); docs/rulings/INSTAPAY-AUTO-1.md; alerts: instapay_repair_failed
