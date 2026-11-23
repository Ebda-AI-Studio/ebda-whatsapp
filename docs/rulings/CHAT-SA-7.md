# CHAT-SA-7

**Ruling CHAT-SA-7 - Operators see standalone workspaces through a new `GET /operator/workspaces?kind=&cursor=` list (cursor-paginated, explicit columns) and mint/revoke invite codes at `/operator/standalone-invites`; suspend/unsuspend/offboard/view-as reuse the existing `:workspaceId` routes unchanged.** Evidence: `operator.ts:359-487` are id-keyed; no list route exists. Cost if wrong: none beyond one extra route if the operator console wants a different filter.

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
