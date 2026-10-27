# Workspace deletion (OFFBOARD-1, iceberg B2 / M-042)

An owner or an operator can delete a workspace. Nothing is deleted at once: a **14-day cooling-off** gives the owner time to change their mind. After it a resumable job erases everything the merchant put here and keeps only the money records the law requires.

## API
| Who | Call | Notes |
|---|---|---|
| Owner | `POST /api/v1/stores/:id/offboarding` `{ confirm: true, acceptWriteOff?, reason? }` | 202 with the status. `confirm` must be literally `true`. The owner cannot skip the wait (a strict schema: `immediate` is a 400). |
| Owner | `GET` / `DELETE /api/v1/stores/:id/offboarding` | status / cancel (only while `pending`). A suspended workspace may still POST and GET, never DELETE. An owner cannot cancel a deletion an operator started: `403 operator_requested` (the help guide tells them to write to support). |
| Operator | `POST /api/v1/operator/workspaces/:id/offboarding` `{ reason, immediate?, acceptWriteOff? }` | A reason (5+ characters) is required. `immediate` skips the cooling-off (a legal request). Asking again can only shorten the wait. |
| Operator | `DELETE .../offboarding` `{ reason }`, `GET .../offboarding`, `GET /operator/offboardings?state=`, `POST /operator/offboardings/run` | cancel, read, list, finish an interrupted run now. |

A wallet balance above zero is refused (`409 wallet_balance_remains`) unless the request carries `acceptWriteOff: true`; the amount is recorded in `offboarding.write_off_minor`. Refund it first through the normal refund path if the merchant wants the money back (WA-REFUND-1 applies to a cancelled plan).

An operator asking while an owner request is pending TAKES IT OVER in one conditional statement (role, requester, reason, the earlier of the two dates, the write-off), so the owner can no longer cancel it; an owner asking never downgrades an operator-owned row. Every change writes exactly ONE `offboarding_log` row in the same batch (`taken_over` or `operator_changed`, detail = previous and new values plus `taken_over` / `expedited` flags); a request that changes nothing writes nothing. The wallet balance is read again: if it grew beyond the write-off the owner accepted, the operator gets `409 write_off_required` with `amountMinor` and must pass `acceptWriteOff: true` (the new amount replaces the stored one and is in the log).

## Race safety (security review)
The run is claimed with ONE conditional write (`state IN ('pending','running') AND execute_after <= now`, `meta.changes` checked); a row cancelled or not yet due since it was read is `skipped`. The state is re-read (`running`) before EVERY step, so a cancel that lands mid-run stops before the next destructive step. Cancel itself only succeeds on `pending`, so once the claim wins the deletion is irreversible by design.

## What the run does (daily cron, or "run now")
Steps are idempotent and recorded in `offboarding.steps_done`; a failed run resumes at the failing step (alert `offboarding_failed`, P1) and a finished one is a no-op.
1. **hold check** (before anything is touched): an open refund, an open card refund or a payment still being confirmed holds the run (`last_error = held:<reason>`, alert `offboarding_held`, P1, once). It retries daily.
2. `suspend`: D1 + the workspace's own copy.
3. `unroute`: the workspace's numbers, funding and **WhatsApp business tokens** are deleted first, so a late webhook finds no workspace.
4. `shared`: parked platform-number messages for customers only this store wrote to, then its routing rows.
5. `wipe_do`: Vectorize vectors, sockets closed, alarm cancelled, ALL Durable Object storage erased, one tombstone left (a stray call can never recreate the schema).
6. `r2`: `bodies/`, `media/`, `uploads/`, `imports/`, `instapay-proof/` under the workspace id (up to 20,000 objects per prefix per run; more continues next pass).
7. `backups`: `backups/<id>/` in the backup bucket.
8. `d1`: one batch. Subscription, store-plan and shared-number rows are deleted. Money rows stay (below). The workspace row is replaced by a tombstone under the pseudonym and removed.

## What is kept, and why
`src/core/ops/offboarding.ts` `OFFBOARD_TABLES` decides every D1 table that names a workspace (a test walks the schema, so a new table fails CI until someone decides).
- **Money records (tax, refunds, disputes)** `topups, package_orders, package_refund_plans, instapay_requests, refund_requests, card_refunds, wallet_adjustments, shared_number_usage`: `workspace_id` becomes a **keyed-HMAC pseudonym** `del_<32 hex>` (HMAC-SHA-256 over the id, key HKDF-derived from `TOKEN_ENC_KEY`, label `offboard-pseudonym/v1`), the merchant's user id in `created_by` / `requested_by` becomes the same pseudonym, free text (`note`) and the InstaPay proof reference are cleared. Amounts, dates and operator ids stay.
- **Immutable ledgers** `ledger_mirror`, `billing_audit` (UPDATE/DELETE are blocked by trigger) and the **audit trails** `operator_actions`, `offboarding`, `offboarding_log` keep the opaque workspace id.
- Everything else (numbers, tokens, subscriptions, routing, all DO data, all R2 objects) is deleted.

**Ruling OFFBOARD-AUDIT-1 - immutable ledgers and audit trails keep the opaque workspace id; they cannot be pseudonymised.** Evidence: database triggers `ledger_mirror_no_update`, `billing_audit_no_update`, `operator_actions_no_update`. The id is a random identifier that names nobody once the workspace row, the DO and R2 are gone; the name lives in the Store, not here. Cost if wrong: a regulator who holds both the Store's mapping and these rows can link the money back to the store; if that is ever required to be impossible, the triggers need a new migration that allows an offboarding-only rewrite.

**Ruling OFFBOARD-PROOF-1 - InstaPay proof images are deleted with the workspace; the request row (amount, reference, deciders, dates) stays.** The bank statement is the evidence of the transfer. Cost if wrong: a dispute about one transfer cannot be settled from the image; ask the merchant's bank.

**Ruling OFFBOARD-HOLD-1 - money in flight holds the run instead of cutting it off.** Cost if wrong: a merchant who abandons a refund request keeps the deletion waiting until an operator rejects it.

**Ruling OFFBOARD-KEY-1 - a deletion is refused (`no_key`) when `TOKEN_ENC_KEY` is missing.** It is a required secret; without it money records could not be pseudonymised. Cost if wrong: none (the secret is checked by `/health`).

## Audit
`offboarding_log` (append-only): `requested`, `expedited`, `cancelled`, `started`, `step_done` (step name and counts), `completed`, with actor and reason. No phone number or message text is ever written.

## Not covered here
The Store's own account deletion drives the owner path (it calls the same endpoint through the owner's session); there is no Store-to-WhatsApp event for it yet. Cloudflare's own copy (R2 versions do not exist; D1 Time Travel keeps 30 days of history and cannot be edited) is covered in the data-residency note in `docs/data-protection.md` once W2-RETENTION lands.
