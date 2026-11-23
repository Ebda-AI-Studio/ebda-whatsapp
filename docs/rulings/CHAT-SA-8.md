# CHAT-SA-8

**Ruling CHAT-SA-8 - Security: creation needs a verified person token (no integrator, session revocation checked as a write), audited (`workspace.created`, `member.added|removed`, `invite.minted|consumed`); tenancy is held by the prefix branch and proven by a negative test matrix; workspace erasure = the existing offboarding flow with Store steps skipped; Chat-only identity export/erase = accounts `exportUser`/`eraseUser`, run by an operator runbook tonight (a self-serve "delete my account" in Chat is NOT shipped tonight), and erasing an identity that still owns a live standalone workspace is refused until the workspace is offboarded.** Evidence: `middleware.ts:107-114` (session check on writes), `index.ts:242-259` (RPCs exist), `offboarding.ts:25`. Cost if wrong: a Chat-only person asking for erasure waits for support (PDPL allows 30 days) until the self-serve path ships.

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
