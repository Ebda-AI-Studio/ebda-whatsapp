# business_id_unverified (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/numbers/numbers.ts (verifiedBusinessId) while connecting a number, when Meta did not confirm that the Business id sent by the browser owns the WABA. Fields: `workspace`, `why` (`not_owner` means Meta's list does not include the WABA; `graph_error` means the Meta call failed).
## Impact
The connect still succeeds. The `business_id` is stored as NULL, so features that need it (creating the merchant's catalog, see docs/store-link.md) will not work for that workspace. No money or consent impact.
## Check first
1. Search logs for `{"alert":"business_id_unverified"...}` and read `why`.
2. Read D1 `waba_credentials` for the workspace: is `business_id` NULL?
3. Read docs/numbers.md, step 4 of the connect flow.
## Fix
1. For `graph_error`: the merchant reconnects later; the id is kept on a reconnect that supplies it.
2. For `not_owner`: ask the merchant to reconnect and pick the right Business portfolio in Embedded Signup.
3. The system does not retry by itself.
## Verify it is resolved
`waba_credentials.business_id` is set for the WABA after the reconnect and no new alert fires.
## Related
docs/numbers.md; docs/store-link.md; signup_not_configured
