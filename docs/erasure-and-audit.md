# Erasure record and audit log (W2-ERASE: B3, T8, M-093)

## The erasure record (B3)
`DELETE /api/v1/stores/:id/contacts/:waId` erases a person's rows from the workspace (`eraseContact`). Before it does, it writes an **erasure record** in D1 (`erasure_records`): the workspace id, a **keyed hash** of the person (HMAC-SHA-256 over `workspace:waId`, key HKDF-derived from `TOKEN_ENC_KEY`, label `erasure-subject/v1`, 128 bits) and the time. The table holds no phone number and the hash is bound to the workspace.

It lives in D1 on purpose: a disaster-recovery restore replaces the Durable Object, so a record kept only there would be lost with it.

**Two stamps (no clock race).** `erased_at` is written BEFORE the Durable Object deletes; `completed_at` is written AFTER `eraseContact` returned, from the Durable Object's own clock. Both are needed: a backup taken between the two still holds the person.

**Restore rule.** `importSnapshot` verifies the backup (counts, checksums) and then drops EVERY person who has an erasure record, except one whose oldest message in the backup is newer than `completed_at` (they wrote again after the erase finished: a genuine new relationship). The backup's own time is not compared with anything. A record whose erase never reported finishing (`completed_at` NULL) is dropped always. Dropped: the contact, conversation, messages, status events, notes, tags, orders, campaign rows, `store_state` keys (`away:<wa_id>`) and the uploads of their messages; the result carries `erasedSkipped`. A contact imported from a CSV after the erase (no messages yet) is dropped from an old restore and has to be re-imported. If records exist but cannot be applied (no `TOKEN_ENC_KEY`), the restore refuses instead of guessing.

**One list, two users.** `src/core/erasure-targets.ts` (`ERASURE_TARGETS`: table, and how its rows tie to the person) is what `eraseContact` deletes through AND what `dropErased` filters a backup through, so they cannot drift. `test/erasure-record.test.ts` walks the Durable Object schema and fails if a table holding `wa_id`, `contact_id`, `conversation_id`, `wamid` or `message_id` is in neither `ERASURE_TARGETS` nor `ERASURE_EXEMPT` (which carries the reason, e.g. the money records that stay).

**Ruling ERASE-ORDER-1 - the record is written BEFORE the erase, and a failure to write it never blocks the erase.** A data-protection request must go ahead; a failed record raises `erasure_record_failed` (P1) so a human re-runs the erase (idempotent) and the record. Cost if wrong: between a failed record and its repair, a restore could bring that person back.

**Ruling ERASE-HASH-1 - the subject hash is keyed (HMAC), not a plain hash of the phone number.** Phone numbers are low-entropy; a plain hash would be reversible by enumeration. Cost if wrong: rotating `TOKEN_ENC_KEY` changes every hash, so old records stop matching; the rotation procedure (W2-DR) must re-derive them or keep the old key readable.

When a workspace is deleted (OFFBOARD-1) its `erasure_records` go with it: add the table to `OFFBOARD_TABLES.delete` in `src/core/ops/offboarding.ts` when the two branches meet (the schema walk in `test/offboarding.test.ts` fails until you do).

## The audit log (T8)
Append-only D1 table `audit_log` (triggers forbid UPDATE and DELETE): `at, workspace_id, actor, actor_role (owner|staff|operator|integration|system), action, target_type, target_id, detail, status`.
- **What is recorded**: every state-changing call (not GET/HEAD) under `/api/v1` that ends below 400 or with 403, by one middleware (`auditWrites`, `src/core/audit.ts`). `action` is the route pattern (`POST /stores/:storeId/conversations/:conversationId/assign`), so it names the thing done without any content. The target is the first route parameter besides the workspace.
- **What is never recorded**: request bodies, message text, reason text, phone numbers. A `waId` target (or any phone-shaped value) is stored as its keyed hash.
- **Not recorded for volume**: message sends, mark-as-read and media uploads (the content they touch is already in the workspace).
- Operator calls are recorded too (alongside the older `operator_actions`, `billing_audit`, change log, which keep their own detail).
- Read view: `GET /api/v1/operator/audit-log?workspaceId=&actor=&action=&before=&limit=` (super admin, newest first, `before` = the smallest id seen) and the **Action log** tab of the operator console.

**Ruling AUDIT-OPEN-1 - a failed audit write never fails the action; it raises `audit_write_failed` (P1).** The Worker log line `{audit:"action"}` still names it. Cost if wrong: an action during a D1 outage has no row.

**Ruling AUDIT-SKIP-1 - sends, reads and uploads are not audited.** They are the product's volume; who sent a message is on the message (`author`). Cost if wrong: an abusive staff member's sends are not in this log, only in the workspace.

Retention: the log is kept; a workspace deletion keeps it too (it holds only opaque ids). A retention period for it is a legal decision for the lawyer review.
