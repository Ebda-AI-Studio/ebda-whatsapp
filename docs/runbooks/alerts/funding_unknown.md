# funding_unknown (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/billing/engine.ts (onClaim) when a send is claimed for a phone number that has no funding row, so nobody is known to pay Meta. Field: `workspace`. The send fails closed.
## Impact
The message is marked failed with reason `funding_unknown`; the API answers 409; a campaign on that number is paused with pause reason `funding_unknown`. Nothing is sent and nothing is charged. No money is wrong.
## Check first
1. Search logs for `{"alert":"funding_unknown"...}` and note `workspace`.
2. Find the number: the failed messages in that workspace (`error_reason = 'funding_unknown'`) and the campaign pause reason.
3. Read docs/billing.md, section "Who pays Meta (WA-FUND-1)". A number with no row is `unknown`; nothing stamps a default.
## Fix
1. Set the funding for the number with the operator route `PUT /api/v1/operator/numbers/:phoneNumberId/funding` (super admin). Which value to choose: Not documented in code: ask the engineer on call (see the WA-FUND-1 section).
2. Find why the number has no funding row (the connect path should write one). Not documented in code: ask the engineer on call.
3. The merchant resends failed messages and resumes any paused campaign; the system does not do this itself.
## Verify it is resolved
A new send on that number is accepted (no 409) and the alert stops.
## Related
docs/billing.md#who-pays-meta-wa-fund-1; docs/shared-number.md; rate_unavailable
