# meta_user_removed_app (P1)
**Severity:** P1 look today
## What it means
Meta's data-deletion callback (`POST /meta/data-deletion`) reported that a person who connected a WhatsApp number to a workspace (agency staff, an ex-employee, the owner) removed the app. We erased that person's link (`waba_signup_users`) and **disconnected nothing**. Fields: `workspace`, `waba` (public ids). The owner sees a notice on the Numbers screen (`workspace_notices`, kind `meta_user_removed_app`).
## Impact
No outage. The number keeps sending. The risk is the other direction: the person who left may still hold access to the merchant's WABA, so the owner has to decide.
## Check first
1. The notice is open: `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT id, workspace_id, ref, created_at FROM workspace_notices WHERE kind = 'meta_user_removed_app' AND resolved_at IS NULL"`.
2. Write to the merchant through support (docs/support.md): ask whether that person should still have access. Do not disconnect on a guess.
## Fix
1. The owner decides in the Numbers screen: "Keep numbers connected" closes the notice, "Disconnect" removes the number and token (and closes the notice).
2. On the owner's instruction, an operator disconnects with a reason: `POST /api/v1/operator/workspaces/:workspaceId/numbers/:phoneNumberId/disconnect {"reason": "..."}`.
## Verify it is resolved
The `workspace_notices` row has `resolved_at` set, and the Numbers list no longer shows the notice.
## Related
docs/launch/README.md Ruling LEGAL-DELETE-1; src/core/meta/data-deletion.ts; meta_deletion_needs_review
