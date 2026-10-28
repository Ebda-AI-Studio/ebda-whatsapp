# D1 Time Travel: restoring the control plane (T21)

D1 `ebda-wa-platform` holds the control plane: workspaces, phone number and WABA routing, encrypted business tokens, packages and subscriptions, top-ups, card refunds,
InstaPay requests, billing audit and the ledger mirror. It holds **no message content** (that is in the workspace Durable Objects and R2, see `backup-restore.md`).
Time Travel is Cloudflare's point-in-time restore for D1: no setup, the history is always kept (30 days on the Workers Paid plan this account uses).

Check the flags against your installed Wrangler before you rely on this page: `npx wrangler d1 time-travel --help` and `npx wrangler d1 time-travel restore --help`.
`npx wrangler whoami` must show the personal account (`as.montaseer@gmail.com`) first. These commands act on the live database.

## Always first: remember where you are
```
npx wrangler d1 time-travel info ebda-wa-platform
```
Prints the current bookmark. **Write it down before any restore**: a restore returns the bookmark of the state it replaced, and restoring to that bookmark is the undo.

## Restore to a moment
1. Decide the moment (a timestamp just before the bad change) or a bookmark you recorded.
2. Stop writers that matter while you do it: set the Worker to answer 503 on money routes by switching off `TOPUPS_ENABLED` and `PACKAGE_CHECKOUT_ENABLED` (vars in `wrangler.jsonc`, redeploy) so no payment is booked into a state you are about to rewind. Webhooks from Kashier are retried by Kashier, not lost.
3. Restore (in place, replaces the live database):
   ```
   npx wrangler d1 time-travel restore ebda-wa-platform --timestamp=<RFC3339 or unix seconds>
   # or: --bookmark=<bookmark>
   ```
   Note the "previous bookmark" it prints.
4. Verify read-only: `npx wrangler d1 execute ebda-wa-platform --remote --command "SELECT count(*) FROM workspaces"` and spot-check the table you meant to repair.
5. Reconcile what the rewind may have skipped (D1 is rewound; the Durable Objects and Kashier are not):
   - Money: every top-up or package payment between the restore point and now exists at Kashier but may be missing in D1. The daily repairs (`repairTopups`, `repairPackageOrders`, `repairInstapay`) re-grant confirmed payments; read `docs/billing.md` and watch for `topup_unknown_order` and `ledger_mirror_mismatch` (P0, `docs/runbooks/alerts/`).
   - Entitlements: the daily `reconcileEntitlements` pushes the D1 package to each workspace; watch `entitlement_push_failed`.
   - Numbers: a number connected after the restore point has a token in its workspace's history but no D1 row; the merchant reconnects it (Embedded Signup).
6. Switch the money routes back on, redeploy, run `node scripts/verify-prod.mjs --base https://<host> --expect <tip of main>`.
7. Undo (if the restore was wrong): `npx wrangler d1 time-travel restore ebda-wa-platform --bookmark=<the previous bookmark from step 3>`.

## Restore from the export instead (older than 30 days, or Cloudflare unavailable)
`scripts/backup-pull.sh` exports D1 to `~/Backups/ebda-whatsapp/<date>/d1-ebda-wa-platform.sql` every night it runs. Create a NEW database, load the file with `npx wrangler d1 execute <new> --remote --file <export.sql>`, point the Worker's `DB` binding at it (a deploy), then do step 5. `scripts/backup-offsite.sh` keeps a second copy outside Cloudflare.

## Drill (do it once before launch, and after any schema change to the money tables)
Record the bookmark, make a harmless row change in a throwaway workspace row, restore to the recorded bookmark, confirm the row is gone, then restore to the "previous bookmark" and confirm it is back. Write the date and the two bookmarks (not secrets) here: ______
