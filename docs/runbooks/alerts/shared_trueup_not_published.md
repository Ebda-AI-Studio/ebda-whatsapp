# shared_trueup_not_published (P1)
**Severity:** P1 look today
## What it means
`runTrueup` in `src/core/billing/trueup.ts` (the workspace task `shared_number_trueup`) found service charges on a platform number for a month, but the operator never published what Meta actually billed for that number, and more than 25 days (`TRUEUP_WAIT_DAYS`) have passed since the month ended. Fields: `workspace`, `month` (yyyy-mm). The task gives up (returns no retry).
## Impact
That workspace gets no true-up rebate for the month. The wallet is not wrong by the system's own books (the rebate simply was not posted); the merchant is owed their pro-rata share of `max(0, charged - actual)` if Meta billed less than we charged.
## Check first
1. Search the logs for `{"alert":"shared_trueup_not_published"...}` and note `workspace` and `month`.
2. D1 table `shared_trueups` (columns `month`, `phone_number_id`, `rebate_minor`, `total_count`): is there a row for that month and each platform number? D1 table `shared_number_usage` shows what each workspace reported.
3. Read docs/billing.md#month-close-wa-shared-free-1.
## Fix
1. Get Meta's actual billed amount for that month and number, then publish it: `POST /api/v1/operator/trueups` with `{ month, phoneNumberId, actualMinor }` (super admin, once per month and number).
2. Not documented in code: how to re-run the already-abandoned task for a past month: ask the engineer on call.
## Verify it is resolved
`shared_trueups` has the row for the month and number. A `meta_adjust` ledger entry with ref `trueup:<month>:<workspace>` appears in `GET /api/v1/operator/workspaces/:workspaceId/wallet` once the task has run.
## Related
docs/billing.md#month-close-wa-shared-free-1, docs/shared-number.md
