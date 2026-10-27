# Number health and the operator kill switch (W2-META, W2-OPS)

Source of truth: `src/core/numbers/health.ts` (state machine), `src/core/numbers/health-events.ts` (webhooks to states, the platform number), `src/core/ops/kill-switch.ts` (operator actions), `src/core/identity/middleware.ts` (the Worker-side gates). Schema: D1 `0017_number_health_killswitch`, DO migration v34.

## State machine (per phone number)
`green` / `yellow` / `red` / `restricted`. Inputs: `phone_number_quality_update` (`event`), `account_update`, the quality rating read on a status refresh (`refreshNumber`), and the spike guard. **FAIL CLOSED: a quality event only ever holds or raises the state.**

| Signal | Effect |
|---|---|
| FLAGGED, rating RED | -> red (never lowers restricted) |
| DOWNGRADE, rating YELLOW, spike | green -> yellow (never lowers red / restricted) |
| UNFLAGGED, rating GREEN | -> green (not out of restricted) |
| UPGRADE | yellow -> green only (a tier upgrade is not a recovery from red) |
| restriction / ban / violation | -> restricted (beats everything) |
| restriction lifted (REINSTATE, empty `restriction_info`) | restricted -> yellow, never straight to green |
| ONBOARDING, unknown events | no change |

FLAGGED is treated as red because Meta flags a number whose quality is poor: campaigns pause AND new templates stop until Meta says it recovered. All event meanings are INFERRED from Meta's documentation, NOT seen on live traffic: verify on the first real event of each kind.

Worsening a state (and every spike): running and scheduled campaigns on that number are paused with `pause_reason = quality_flagged` and the queued sends are parked; yellow raises P1 `number_quality_flagged`; red / restricted raises P0 `number_restricted`. Red / restricted also refuse every business-initiated TEMPLATE at claim (`error_reason = number_restricted`, hold released) and block campaign start / resume; service replies inside the 24 h window still go. **Recovery never resumes a campaign: the merchant does.**

Spike guard (A5): 25 Meta errors 131049 (frequency cap) or 131026 (undeliverable) on one number inside 60 minutes pause its campaigns, move green to yellow and raise P1 `number_error_spike`. Counted once per NEW status event (a redelivered status does not count again); each Graph rejection that is rescheduled is a separate event. For the platform number errors are attributed per MEMBER (D1 `shared_number_errors`); see Ruling WA-B-SPIKE-1. The threshold is fixed (does not scale with the tier).

## Ordering
Meta retries a webhook for days, so a retried old RECOVERY must not undo a newer restriction. Each Meta-timed signal carries Meta's own time (`entry.time`, ms); the number's newest applied Meta time is kept in D1 (`health_signal_at`) and in the workspace (`number_health_signal`). **Ordering may only drop a stale RECOVERY**: a Meta-timed signal that is older than the newest AND would lower the state (REINSTATE, UNFLAGGED, green) is dropped. A signal that worsens the state (restricted, red, flagged, spike) is ALWAYS applied, whatever its time. Locally generated signals (the spike guard, a rating refresh, a webhook without a time) never take part in the ordering and never advance the ordering column, so they cannot make a later, earlier-stamped Meta DISABLE look stale. Equal times are applied.

## NEVER-stale
State is written to D1 (`phone_numbers.health_*`, `shared_numbers.health_*`) AND the workspace Durable Object (`number_health_log`, the latest row is the state). Nothing caches it. The DO mirror to D1 is awaited: a failure answers the webhook 5xx so Meta redelivers, and the mirror writes only when D1 differs, so a redelivery repairs it.

## The platform (shared) number (A7)
Its state lives on its `shared_numbers` row: ONE state machine, ONE alert (platform level; member copies never alert). The webhook answers Meta once D1 is updated; the new STATE (not the signal) is then pushed to every active member's own Durable Object in the background (`waitUntil`, ten members at a time), tagged with a processing-time version so a late push can never overwrite a newer one. Members are also set to the current D1 state when a store joins or rejoins, and once a day by the shared-number sweep (`reconcileSharedHealth`). While the number is not green: `joinShared` answers `409 number_unhealthy`, `GET /shared-number` reports `available: false`. The platform number is looked up BEFORE a store's own numbers (a stray `phone_numbers` row can never shadow it), and `connect` refuses a number id that is a platform number.

## Operator kill switch (super admin only)
`POST /api/v1/operator/workspaces/:id/{suspend,unsuspend,campaigns/pause,shared-number/evict,shared-number/readmit,integrations/revoke,integrations/restore}` with `{ reason }` (5-300 characters). `GET .../ops` shows the state. Every call first writes one append-only `operator_actions` row (actor, action, reason; triggers refuse UPDATE and DELETE) and re-checks the operator session (fail closed).

- **Suspend**: D1 `workspaces.suspended_at` AND the workspace's own copy. The Worker refuses every write with `403 workspace_suspended` except paying (`/wallet`, `/packages`) and erasing a contact; the Durable Object refuses every send at claim (alarms, retries, queued jobs; checked AFTER the duplicate checks, so an already-sent redelivery keeps its hold and an in-flight claim stays in flight), and the AI agent, the ordering bot and the front desk answer nothing; campaigns are paused (`operator_paused`). Reading and inbound webhooks continue. Unsuspend resumes nothing. If the workspace copy cannot be reached the call answers `503 unavailable` (`suspended_in_d1_workspace_copy_pending_retry`): the D1 half is already active and the same call again finishes it with no second audit row.
- **Pause campaigns**: `operator_paused` on every running / scheduled campaign.
- **Evict / readmit**: the store leaves the platform number (funding map refreshed, routes removed) and cannot rejoin (`403 evicted`) until readmitted.
- **Revoke integrations**: sets `workspaces.integrations_revoked_at`; while it is set EVERY integrator token of the store is refused (`401`), including one minted after the revoke (a client re-mints every few minutes, so an issue-time cut-off would not hold). `integrations/restore` clears it. D1 is read on every integrator request: no cache.
- **M-135**: a person token is checked against the accounts service (`isRevoked(sessionId)`) on EVERY write, not only money: revoked -> `403 session_revoked`, accounts unreachable -> `503 unavailable` (`session_check_unavailable`, fail closed). Reads are never blocked.

## Rulings
- **Ruling WA-B-ALERT-1 - a suspension raises no alert, only the append-only audit row and the `operator_suspend` audit log line.** Every kill-switch action is done by a named super admin who already knows it; a Telegram message to the same people would be noise, and the severity pin (`INFO_ALERTS` = 20 names) is untouched. The things on-call must hear about are the consequences Meta causes (`number_quality_flagged`, `number_error_spike`, `number_restricted`). Cost if wrong: a second operator learns of a suspension only from `operator_actions` / the console card's history, not from Telegram; add `workspace_suspended` to INFO_ALERTS (pin 21) if that proves too quiet.
- **Ruling WA-B-SHARED-1 - the platform number's health is set on every active member's own copy (state push after the D1 write, on join / rejoin, and daily), and read from D1 by `joinShared` / `sharedStatus`.** The alternative (a D1 read inside `claimSend`) would make the send gate async. Cost if wrong: a push that never arrives (member DO unreachable; Meta does not redeliver a webhook that got a 200) leaves that member on its old copy until the next join or the daily reconcile (at most about a day); the send gate of such a member is then wrong in either direction for that window.
- **Ruling WA-B-FLAG-1 - FLAGGED is treated as red.** Fail closed: a number Meta flags stops new templates as well as campaigns until Meta sends UNFLAGGED or a GREEN rating. Cost if wrong: if Meta's FLAGGED is only a mild warning, merchants lose template sends until the recovery event arrives.

- **Ruling WA-B-SPIKE-1 - the platform number trips for everyone only when the errors come from at least 3 distinct members (`SHARED_SPIKE_MIN_MEMBERS`).** Below that, one member that produced at least 80% of the window's errors (`SHARED_DOMINANCE`) is the culprit: only ITS template sends on the number stop for 24 h (`MEMBER_BLOCK_MS`, P1 `number_member_abuse`); with two members and no clear culprit only an alert is raised. Otherwise one abusive store could pause every other store's sending on a number they share. Cost if wrong: a number-wide problem that happens to show up in only one or two members is not tripped for the others (Meta's own rating/FLAGGED webhooks still trip it); an innocent dominant member (e.g. the only active store) is blocked for up to a day (the operator can evict or readmit it).
- **Ruling WA-B-ORDER-1 - ordering only drops a stale recovery.** Fail closed: a worsening signal always applies, so a retried old FLAGGED/DISABLE can re-worsen a number Meta later recovered; the next UNFLAGGED/REINSTATE (newer than the newest applied) recovers it again. Cost if wrong: a number is briefly restricted again by a retried old event until Meta's next recovery signal.

## Not verified against real Meta
The `account_update` shapes and the quality event meanings are inferred from Meta's documentation (event names, `restriction_info`, `ban_info.waba_ban_state`); verify on the first real event. Thresholds are starting values.
