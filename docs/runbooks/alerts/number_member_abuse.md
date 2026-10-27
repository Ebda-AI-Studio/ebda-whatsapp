# number_member_abuse (P1)
**Severity:** P1 look today
## What it means
On the shared platform number one store produced nearly all of a spike (at least 80% of 25 errors in 60 minutes) while over the error bar, so its own template sends were blocked for 24 h (src/core/workspace-do.ts, `noteSendError`). Fields: `workspace` (the blamed store), `phoneNumberId`, `shared: true`.
## Impact
Only that store's template sends on the platform number stop for up to 24 h. Other stores are not blocked unless the rest of the errors also trip the platform number. No money is wrong.
## Check first
1. Search logs for `{"alert":"number_member_abuse"`.
2. Read D1 `shared_number_errors` and `shared_number_sends` for the number, and `shared_number_members` for that workspace.
3. Read docs/number-health.md, Ruling WA-B-SPIKE-1.
## Fix
1. Contact the merchant about their template content and audience.
2. If they keep abusing it, POST /api/v1/operator/workspaces/:workspaceId/shared-number/evict; undo with .../shared-number/readmit.
3. The 24 h block lifts itself.
## Verify it is resolved
No repeat alerts for that workspace after 24 h, or the member is evicted and shows in GET /api/v1/operator/workspaces/:workspaceId/ops.
## Related
docs/number-health.md, docs/shared-number.md, alert: number_error_spike
