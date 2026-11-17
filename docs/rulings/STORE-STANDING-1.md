# Ruling STORE-STANDING-1

**Decision:** a Store store that is suspended (billing `unpaid` / `over_store_limit`, or by a super admin) or deleted stops EVERY Ebda Chat spend for its workspace - sends of any kind, campaigns, automatic and AI replies, background Workers AI - including a package the merchant bought in Ebda Chat itself, until the Store sends `store.reactivated` (ebda-store #839, contract v1.6).

**How:** the Store announces its standing on every write of `stores.status` / `deletedAt` and on delete (one database observer, after commit) and re-sends it every 12 hours. The workspace keeps a Store hold flag next to the operator's suspension flag in its own SQLite; `isSuspended` reads both on every send claim and inbound turn, so the gate has no cache and no staleness window inside the workspace (NEVER-stale class). The bound end to end is the queue delivery after the Store's commit (seconds; a missed observer is corrected by the 12-hourly reconcile). D1 follows the workspace's decision with a tagged `suspended_reason` (`store_suspended` / `store_deleted`), the offboarding precedent. Older events are dropped by `at`. The two flags never lift each other.

**Why all spend, not only `store-included`:** the issue's first sketch stopped only the store-included package on a billing suspension; the controller's brief (2026-11-15) asked for ALL cost-bearing sends. A suspended store is also one that may be suspended for abuse, and the workspace id IS the store id; one rule is simpler and fails closed.

Cost if wrong: a merchant who pays Ebda Chat separately loses Chat sending while only their Store subscription is unpaid; they get it back the moment the Store store is reactivated.
