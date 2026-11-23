# CHAT-SA-1

**Ruling CHAT-SA-1 - A Chat-only account is created by the accounts app's existing store-less signup (`POST /signup` -> code -> `/otp/verify`) behind a new Chat-branded page `accounts.ebda.app/signup?product=chat`; Chat learns memberships from a Chat-side D1 `workspace_members` table keyed by the accounts user id, NOT from a new token claim.** Evidence: `registerPending` already inserts no store (`app.ts:633-671`); a `workspaces` claim would make accounts (and `STORE_DIRECTORY`) a second membership authority and widen what a 15-minute token can grant after a removal, while a D1 row is read live on every request exactly like the existing kill-switch read (`middleware.ts:126-129`). Cost if wrong: if a later product needs standalone memberships outside Chat, a claim or directory call must be added then (additive, no migration of tokens).

Source: `docs/plans/2026-11-23-chat-standalone-workspaces.md` (approved by Ahmad, 2026-11-23).
