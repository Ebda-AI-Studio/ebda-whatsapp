# store_standing_stale (P1)
**Severity:** P1 look today
## What it means
Fires from the workspace (src/core/workspace-do.ts, `alertIfStandingStale`) when `STORE_STANDING_STALE_REFUSE=1` and a linked workspace has received no Store standing (suspended / reactivated / deleted, re-sent every 12 h) for more than 24 hours, or none since the link. Fields: `workspace`, `lastStandingAt`.
## Impact
That workspace's spend is refused (sends, campaigns, AI and automatic replies) with `workspace_suspended` until the Store's next standing arrives. It never fires while the switch is off.
## Check first
1. Is it one workspace or all of them? All of them means the Store side stopped sending (ebda-store standing emitter or its queue), not a merchant problem.
2. The operator console, kill-switch card, shows "Last standing from the Store" for the workspace.
3. Read docs/rulings/STORE-STANDING-2.md.
## Fix
1. If the Store emitter or queue is down, restore it; the next heartbeat re-opens spend by itself.
2. If it is widespread and cannot be fixed quickly, turn the switch off: set `STORE_STANDING_STALE_REFUSE` to 0 and deploy.
## Verify it is resolved
The console shows a recent last standing for the workspace and a send claims normally.
## Related
docs/rulings/STORE-STANDING-1.md; docs/rulings/STORE-STANDING-2.md
