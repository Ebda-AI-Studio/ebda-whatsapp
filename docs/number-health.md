# Number health and the operator kill switch (W2-META, W2-OPS)

Source of truth: `src/core/numbers/health.ts` (state machine), `src/core/numbers/health-events.ts` (webhooks to states), `src/core/ops/kill-switch.ts` (operator actions), `src/core/identity/middleware.ts` (the Worker-side gates). Schema: D1 `0017_number_health_killswitch`, DO migration v35.

## State machine (per phone number)
`green` / `yellow` / `red` / `restricted`. Inputs: `phone_number_quality_update` (`event`), `account_update`, the quality rating read on a status refresh (`refreshNumber`), and the spike guard.

| Signal | Effect |
|---|---|
| FLAGGED, DOWNGRADE, rating YELLOW | green -> yellow |
| rating RED | -> red (unless restricted) |
| UNFLAGGED, UPGRADE, rating GREEN | -> green (unless restricted) |
| restriction / ban / violation | -> restricted (beats everything) |
| restriction lifted (REINSTATE, empty `restriction_info`) | restricted -> yellow, never straight to green |
| ONBOARDING, unknown events | no change |

Worsening a state (and every spike): running and scheduled campaigns on that number are paused with `pause_reason = quality_flagged` and the queued sends are parked; yellow raises P1 `number_quality_flagged`; red / restricted raises P0 `number_restricted`. Red / restricted also refuse every business-initiated TEMPLATE at claim (`error_reason = number_restricted`, hold released); service replies inside the 24 h window still go. A campaign cannot be started or resumed on a red / restricted number. **Recovery never resumes a campaign: the merchant does.**

Spike guard (A5): 25 Meta errors 131049 (frequency cap) or 131026 (undeliverable) on one number inside 60 minutes pause its campaigns, move green to yellow and raise P1 `number_error_spike`. The counters reset after a trigger. The threshold is fixed (does not scale with the tier).

## NEVER-stale
State is written to D1 (`phone_numbers.health_*`, `shared_numbers.health_*`) AND the workspace Durable Object (`number_health_log`, the latest row is the state). Nothing caches it. The DO mirror to D1 is awaited: a failure answers the webhook 5xx so Meta redelivers, and the mirror writes only when D1 differs, so a redelivery repairs it.

## The platform (shared) number (A7)
Its state lives on its `shared_numbers` row and the same signal is pushed to every active member's own Durable Object (so `claimSend`, campaign start and resume see it with no D1 read). While it is not green: `joinShared` answers `409 number_unhealthy`, `GET /shared-number` reports `available: false`. Not covered: a message already queued by a member before the signal arrives is refused at claim (templates only).

## Operator kill switch (super admin only)
`POST /api/v1/operator/workspaces/:id/{suspend,unsuspend,campaigns/pause,shared-number/evict,shared-number/readmit,integrations/revoke}` with `{ reason }` (5-300 characters). `GET .../ops` shows the state. Every call first writes one append-only `operator_actions` row (actor, action, reason; triggers refuse UPDATE and DELETE) and re-checks the operator session (fail closed).

- **Suspend**: D1 `workspaces.suspended_at` AND the workspace's own copy. The Worker refuses every write with `403 workspace_suspended` except paying (`/wallet`, `/packages`) and erasing a contact; the Durable Object refuses every send at claim (alarms, retries, queued jobs) and switches the agent off; campaigns are paused (`operator_paused`). Reading and inbound webhooks continue. Unsuspend resumes nothing.
- **Pause campaigns**: `operator_paused` on every running / scheduled campaign.
- **Evict / readmit**: the store leaves the platform number (funding map refreshed, routes removed) and cannot rejoin (`403 evicted`) until readmitted.
- **Revoke integrations**: `workspaces.integrations_revoked_at`; every integrator token issued at or before it is refused (`401`) on the next request (D1 read per request, no cache). Tokens issued after it work.
- **M-135**: a person token is checked against the accounts service (`isRevoked(sessionId)`) on EVERY write, not only money: revoked -> `403 session_revoked`, accounts unreachable -> `503 session_check_unavailable` (fail closed). Reads are never blocked.

## Not verified against real Meta
The `account_update` shapes are inferred from Meta's documentation (event names, `restriction_info`, `ban_info.waba_ban_state`); verify on the first real event. Thresholds are starting values.

## Rulings
- **Ruling WA-B-ALERT-1 - a suspension raises no alert, only the append-only audit row and the `operator_suspend` audit log line.** Every kill-switch action is done by a named super admin who already knows it; a Telegram message to the same people would be noise, and the severity pin (`INFO_ALERTS` = 20 names) is untouched. The things on-call must hear about are the consequences Meta causes (`number_quality_flagged`, `number_error_spike`, `number_restricted`). Cost if wrong: a second operator learns of a suspension only from `operator_actions` / the console card's history, not from Telegram; add `workspace_suspended` to INFO_ALERTS (pin 21) if that proves too quiet.
- **Ruling WA-B-SHARED-1 - the platform number's health is pushed to every active member's own Durable Object and read from D1 by `joinShared` / `sharedStatus`.** The alternative (a D1 read inside `claimSend`) would make the send gate async and cacheable. Cost if wrong: a member that joins in the instant between a signal and its push keeps a green copy until Meta redelivers or the next signal; a member DO that is unreachable at push time makes the webhook answer 5xx so Meta redelivers.
