# CHAT-SA-4

**Ruling CHAT-SA-4 - Standalone teams live in Chat: owner + staff in `workspace_members`; the owner invites by email through a new accounts RPC `inviteChatMember` (creates an unverified identity via the existing `inviteFor`, or resolves an existing one) and the answer to the owner is identical either way ("invite sent"); seats reuse the DO `seats` table and `memberLimit`; removal flips the row to `removed` and drops the seat in the same request.** Evidence: Store team semantics are owner/staff + seat by assignment (`seats.ts:1-6`, `capabilities/team.invite-roles.capability.json:34`); `inviteUser` already exists (`index.ts:286`). Cost if wrong: if this task slips, standalone workspaces launch owner-only (the safe cut, Task 6).

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
