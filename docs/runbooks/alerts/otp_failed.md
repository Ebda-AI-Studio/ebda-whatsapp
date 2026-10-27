# otp_failed (P1)
**Severity:** P1 look today
## What it means
`sendOtp` in `src/core/otp.ts` threw while sending a login code over WhatsApp for a store. Fields: `storeId`, `error` (error class). The caller gets `unavailable`.
## Impact
That buyer or merchant did not get the code on WhatsApp. Email stays the main channel and the caller falls back to it, so users are slowed, not blocked. No money impact. The code itself is never logged.
## Check first
1. Search the logs for `{"alert":"otp_failed"...}`; note `storeId` and `error`.
2. Is the store known and does it have its own number (not the shared number)? `no_number` and `not_found` are normal results, not this alert.
3. Check the workspace Durable Object is reachable and the Meta Graph status.
4. Read docs/store-link.md#otp-over-whatsapp-otp-1.
## Fix
1. Fix the cause shown in `error` (a Durable Object or D1 failure, or Meta).
2. The system does not retry; the next request for a code tries again.
## Verify it is resolved
A new code request for that store returns `ok` and no new `otp_failed` line appears.
## Related
docs/store-link.md#otp-over-whatsapp-otp-1, number_restricted
