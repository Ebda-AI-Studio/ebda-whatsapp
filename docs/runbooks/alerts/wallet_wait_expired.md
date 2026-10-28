# wallet_wait_expired (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/workspace-do.ts when a send waiting for wallet funds ran out of time (up to 48 h, and not past the 24 h window for free text). Field: `workspace`, and `reason` on the release path (`wallet_empty_expired` or `window_closed`).
## Impact
The queued message is failed (`wallet_empty_expired` or `window_closed`) and its hold is released. A campaign message pauses that campaign with reason `wallet_empty`. A customer did not get a message because the merchant's wallet stayed empty. No money is wrong.
## Check first
1. Search logs for `{"alert":"wallet_wait_expired"...}` and note `workspace`.
2. Check the wallet: `GET /api/v1/operator/workspaces/:workspaceId/wallet` (super admin).
3. Read docs/billing.md, section "Money flow for a platform_line message", step 2 (utility / service messages WAIT).
## Fix
1. The merchant tops up the wallet. The system does not resend expired messages.
2. The merchant resends failed messages and resumes any paused campaign.
3. If the wallet balance looks wrong, see ledger_mirror_mismatch.
## Verify it is resolved
The wallet balance covers new sends, new sends are accepted, and the alert stops.
## Related
docs/billing.md#money-flow-for-a-platform_line-message; wallet_low_balance; ledger_mirror_mismatch
