# package_refund_unmatched (P1)
**Severity:** P1 look today
## What it means
`applyPackageWebhook` in `src/core/billing/package-orders.ts` received a confirmed refund for a package order that is not in a refundable state (its status is not `paid`, or the refund amount is 0 or less) and the refund is not a replay. Fields: `workspace`, `orderId`. The refund is reported as `unmatched` and nothing is applied.
## Impact
Money may be wrong. Kashier refunded a card payment that our order does not treat as an open paid package, so the merchant may keep a plan they were refunded for, or a refund was already applied in another way.
## Check first
1. Search the logs for `{"alert":"package_refund_unmatched"...}`; note `workspace` and `orderId`.
2. D1 `package_orders` for the order (`status`, `amount_minor`, `refunded_minor`) and `package_refunds` for refund refs of the order.
3. Kashier's dashboard: which payment was refunded and for how much.
4. Read docs/billing.md#packages-three-writers-one-place-package_checkout_enabled-for-purchase.
## Fix
1. Decide with the engineer on call whether the refund duplicates one already applied (nothing to do) or needs the plan changed.
2. Not documented in code: applying a plan change for it: ask the engineer on call. `PUT /api/v1/operator/workspaces/:workspaceId/subscription` exists for operator plan changes. The system does not repair this itself.
## Verify it is resolved
The order and the workspace plan match what Kashier shows as refunded, and no new alert appears for the order.
## Related
package_refund_contention, refund_refused, docs/billing.md#packages-three-writers-one-place-package_checkout_enabled-for-purchase
