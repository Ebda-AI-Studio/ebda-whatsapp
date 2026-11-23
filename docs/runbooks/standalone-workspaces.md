# Standalone workspaces (Ebda Chat without an Ebda Store): operator runbook

Rulings CHAT-SA-1..9 (`docs/rulings/CHAT-SA-*.md`). A standalone workspace has an `sw_<26 base32>` id, `workspaces.kind = 'standalone'`, its team in `workspace_members`, and no Store bridge.

## The flag
`STANDALONE_WORKSPACES` (wrangler var, default `off`; any other unknown value also means `off`):
- `off`: nobody can create one (`403 standalone_off`). Existing standalone workspaces keep working.
- `invite`: creation needs an operator-minted single-use code. This is the launch setting.
- `open`: no code. Only after the public entry point exists (CHAT-SA-9: no ebda.app CTA until then).
Change it with a one-line var edit and a deploy. Keep it `off` until the web app can create a workspace.

## Invite codes
Mint: `POST /api/v1/operator/standalone-invites {"note":"client name","days":14}` (max 30 days). The response carries the plain `code` once; D1 holds only a keyed hash. List: `GET /operator/standalone-invites` (hash, who minted, expiry, used by / workspace, revoked). Revoke an unused code: `POST /operator/standalone-invites/:hash/revoke`. A code is consumed in the same D1 batch that creates the workspace, so a refused attempt never burns it. Wrong, used, expired and revoked codes all answer the same `invite_invalid`.

## Abuse limits
Every creation attempt (refused ones too) is counted in `workspace_creations`: 3 per person and 10 per IP (hashed) per 24 h, then `429`. Rows older than 2 days are pruned by the daily cron. One owned standalone workspace per person (`409 already_owns_workspace`); a second needs an operator.

## Listing, suspending, offboarding
`GET /operator/workspaces?kind=standalone&cursor=` (50 per page, newest first). Suspend, unsuspend, offboard and view-as use the existing `/operator/workspaces/:workspaceId/...` routes unchanged.

## Erasing or exporting a Chat-only person
There is no self-serve delete in Chat yet. On a request: (1) if they own a live standalone workspace, offboard it first (the identity erase is refused while it lives); (2) run accounts `exportUser` / `eraseUser` for their user id; (3) record the request and the date (PDPL: within 30 days). Their `workspace_members` rows are removed with the workspace; a removed staff member's row stays as `status = 'removed'`.

## Billing
Chat purchases only; no `store-included`, no trial, and the first InstaPay payment is always reviewed by a person (`docs/billing.md`, CHAT-SA-6).
