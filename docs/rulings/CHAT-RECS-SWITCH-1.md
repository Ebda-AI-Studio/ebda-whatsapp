# Ruling CHAT-RECS-SWITCH-1 (Ahmad, 2026-11-23; built on feat/chat-proactive-recs)

**Decision:** proactive "you might also like" after an order (register row 309) is built now, behind a workspace switch that is OFF by default and owner-only. It is enabled for a store only after (1) Meta has approved a MARKETING template for it and (2) the consent design (below) is accepted for that store. One template message per order, at most 3 products from the Store's recommendation engine (bridge `getRecommendations`, `mode: complement`, seeded from the buyer's own order with the buyer proof).

**Gates (all must be true, each re-read when the task runs, not when the order arrives):** switch ON · approved template name configured and APPROVED in the workspace with category MARKETING · explicit marketing consent on the contact (`contacts.consent_at`, no opt-out; consent given only at Store checkout counts once the customer has written to us, the campaign rule) · not between 21:00 and 09:00 in the shop time zone (deferred to the first morning quarter-hour, never dropped) · at most one such message per customer per 14 days · something in stock to suggest · order not cancelled, refused or returned. A non-send always records `store_orders.recs_outcome = skipped:<reason>` (switch_off, no_template, no_consent, opted_out, frequency_cap, nothing_to_suggest, order_not_active, template_not_approved, wallet_empty, plan_required, ...).

**Money:** the wallet is touched only inside `queueTemplate` after every gate above passed. Switch OFF means no task is scheduled, no Store call, no hold, no ledger row. A refusal (empty wallet, plan) writes nothing.

**Failure and idempotency:** one decision per order (`store_orders.recs_outcome`, message key `recs:<orderId>`, claim re-checked inside the queueing transaction). If queueing throws, the transaction rolls back, the order is marked `failed:enqueue` and an alert is raised; no orphan `queued` row. A Store outage or not-yet-loaded pricing retries with backoff up to 6 attempts, then records the reason.

**Contract:** `src/core/api/store-events.ts` is unchanged (WA-CONTRACT-1); the feature uses the existing `order.created` event and the existing bridge method.

**Template shape the merchant submits:** MARKETING, two body variables: `{{1}}` customer name, `{{2}}` product list ("name (price CUR) - name (price CUR) - ..."). Chat never assumes approval.

**Consent design still needed before enabling for a real store:** the Store checkout tick wording must name product suggestions after an order (today it says marketing messages in general), and the owner must accept that the message is charged to the wallet. Until then the switch stays OFF everywhere.

**Evidence:** `test/proactive-recs.test.ts` (16 tests: switch off, switch re-read, owner-only, no template, template not approved, no consent, checkout-only consent, STOP, quiet hours deferral, frequency cap, nothing in stock, cancelled order, happy path with wallet hold, idempotency, enqueue throw, Store outage). Each gate was removed in turn (cap, consent, switch, scheduling) and its test failed.

**Cost if wrong:** none while the switch is off. If enabled with a weak consent wording, customers get a marketing message they did not clearly agree to (Meta quality rating and a data-protection complaint risk) and the merchant pays for it; the 14-day cap and STOP handling bound the volume.
