# ledger_mirror_mismatch (P0)
**Severity:** P0 wake someone now
## What it means
`checkMirror` in `src/core/billing/mirror.ts` compares, per ledger (`wallet` or `credit`), the sum and row count in the workspace Durable Object with the D1 `ledger_mirror` table. Rows still waiting in `ledger_outbox` are excluded, so a mid-drain check is not a false alarm. Fields: `workspace`, `ledger`, `doSum`, `d1Sum`, `doRows`, `d1Rows`.
## Impact
One merchant's wallet (or AI credit) history differs between the two stores. Money may be wrong. No merchant action is blocked by the alert itself.
## Check first
1. Search logs for `{"alert":"ledger_mirror_mismatch"...}`; note `workspace` and `ledger`.
2. Compare `doSum`/`d1Sum` and `doRows`/`d1Rows`: a row-count gap means missing or extra mirror rows; equal counts with different sums means an amount differs.
3. Read the merchant balance: `GET /api/v1/operator/workspaces/:workspaceId/wallet`.
4. D1 side (read only): `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT ledger, count(*), sum(amount) FROM ledger_mirror WHERE workspace_id = '<id>' GROUP BY ledger"`.
5. Read docs/billing.md (Tables section, `ledger_outbox` row).
## Fix
1. The outbox drains itself through the `ledger_drain` task in the workspace; a gap caused only by a pending drain closes without help.
2. If it persists, do not edit ledger or mirror rows (they are append-only; the mirror is immutable by trigger).
3. Which side is right: Not documented in code: ask the engineer on call. Any correction goes through the documented operator adjustments (`POST /api/v1/operator/workspaces/:workspaceId/adjustments`), only after the engineer decides.
4. How to trigger `mirrorCheck()` on demand: Not documented in code: ask the engineer on call (it is a workspace Durable Object method with no operator route).
## Verify it is resolved
`mirrorCheck()` returns `equal: true` for both ledgers and the alert stops repeating.
## Related
docs/billing.md; docs/runbooks/alerts.md; docs/runbooks/backup-restore.md
