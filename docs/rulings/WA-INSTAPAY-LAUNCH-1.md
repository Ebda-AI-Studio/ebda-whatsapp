# Ruling WA-INSTAPAY-LAUNCH-1

**Decision:** `TOPUPS_ENABLED`, `PACKAGE_CHECKOUT_ENABLED` and `INSTAPAY_BILLING_ENABLED` are `"true"` in `wrangler.jsonc` vars, with `EBDA_INSTAPAY_QR_URL`. InstaPay (receipt + operator confirm) is the launch payment method. Kashier stays UNCONFIGURED (no `KASHIER_MERCHANT_ID` / `KASHIER_API_KEY` / `KASHIER_SECRET_KEY`): it is third-party and not approved.

**Why all three:** the InstaPay card reads its package picker from `GET /packages`, which is behind `PACKAGE_CHECKOUT_ENABLED`; the Wallet screen only shows its top-up area while `TOPUPS_ENABLED`; the InstaPay routes are behind `INSTAPAY_BILLING_ENABLED`. Turning on only the first two would leave the InstaPay routes at 404; turning on only InstaPay would leave an empty package picker.

**What fails closed with Kashier unset (measured in `test/instapay-launch.test.ts`):** `POST /wallet/topups` and `POST /packages/:id/checkout` answer 503 and write no row (`startTopup` / `startPackageCheckout` need a provider that can confirm webhooks); `/kashier/webhook` answers 503; the daily card repair passes return early (no provider). `GET /wallet` carries `cardCheckout: false`, and the Wallet screen then shows an InstaPay pointer instead of the card top-up form and hides the card package list (no dead button). Cards come back by setting the three Kashier values; nothing else changes.

**Evidence (2026-10-29):** approvals queue ad623b1a: payee = the Store's InstaPay account, QR `https://media.ebda.app/platform/instapay-qr.jpg` (200 image/jpeg). `wrangler secret list --name ebda-wa` (read-only, names only) shows NO `EBDA_INSTAPAY_HANDLE`: until it is set the payee is null, the InstaPay card says "unavailable" and create answers 503 (fail closed, nothing written). End to end up to the receipt: create (package and top-up) -> payee shown -> proof upload -> `under_review`, no grant until an operator confirms.

**Controller steps (after merge, before deploy):** `npx wrangler secret put EBDA_INSTAPAY_HANDLE` (the Store's public handle, the SAME value as ebda-api); then `bash scripts/deploy.sh`. Not covered here: a real transfer and operator confirmation in production (needs Ahmad).

**Cost if wrong:** a merchant could create an InstaPay request before an operator is ready to review proofs (SLA alert `instapay_proof_overdue` fires at 4 business hours); a merchant who transfers to a wrong or unset handle loses time, not money, because nothing is granted without the operator's confirmation and an unset handle refuses the request up front.
