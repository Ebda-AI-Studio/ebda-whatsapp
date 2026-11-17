# cod_v2_submit_failed (P1)
**Severity:** P1 look today
## What it means
Fires from src/core/cod-v2.ts when submitting the per-store COD confirmation template (`cod_confirmation_v2`) to Meta failed or threw: right after the Store linked (`store.linked` with a `storefrontOrigin`), or after the merchant's number connected. Fields: `workspace`, `template`, and `error` (error class) when it threw.
## Impact
That store keeps sending the plain `cod_confirmation` message (no store-name header, address or order-page button). Nothing breaks and no order is lost; only the richer message is missing until the template exists and Meta approves it.
## Check first
1. Search logs for `{"alert":"cod_v2_submit_failed"` and note `workspace`.
2. Check the same workspace for `token_unavailable` or Meta errors (`{"alert":"business_token_unavailable"`): a dead token is the usual cause.
3. Read docs/store-link.md (COD v2) and the workspace's Templates screen: is `cod_confirmation_v2` listed, and with which status?
## Fix
1. Fix the cause (renew the connection on the Numbers page if the token is dead). The submission is idempotent and runs again on the next `store.linked` or number connect.
2. To retry now, the merchant opens the Templates screen and uses Resubmit on the template (a REJECTED one), or an engineer calls `POST /stores/:storeId/templates/cod-v2/resubmit`.
## Verify it is resolved
`cod_confirmation_v2` appears in the workspace's templates as PENDING and later APPROVED, and the alert stops for that `workspace`.
## Related
docs/store-link.md; docs/help/en/05-cod-confirmations.md; alert: store_event_failed
