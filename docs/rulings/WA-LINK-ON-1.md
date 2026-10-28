# Ruling WA-LINK-ON-1

**Decision:** the WhatsApp <-> Store link is switched on in `wrangler.jsonc`: service binding `STORE_BRIDGE` -> `ebda-api` (entrypoint `WhatsAppBridge`), queue producer `STORE_EVENTS` -> `ebda-store-events`, queue consumer `ebda-wa-events` (DLQ `ebda-wa-events-dlq`). The `WhatsAppOtp` binding on the accounts side is NOT added.

**Evidence (2026-10-28):**
- Worker name `ebda-api` (`apps/api/wrangler.jsonc`); `export class WhatsAppBridge extends WorkerEntrypoint` at `apps/api/src/worker.ts:442`, the Worker's `main`, on ebda-store main (908272beb).
- `wrangler queues info ebda-wa-events` (account 69188202...): 1 producer (`worker:ebda-api`), 0 consumers, so this Worker is the single consumer. `ebda-store-events(-dlq)` and `ebda-wa-events-dlq` exist (launch README).
- `PROOF_URL_SECRET` and `PUBLIC_BASE_URL` were already in vars / `REQUIRED_SECRETS` (`/health` fails 503 without the secret); `src/env.ts` and `src/core/secrets-check.ts` already agree; no change needed there.
- `WhatsAppOtp` is exported here, but nothing calls it: `apps/accounts/src` has no reference and `apps/api/src` has none. Binding it now would be dead config, so it waits for the caller (the Store's `otpViaWhatsApp` work).

**Deploy order:** `ebda-api` must already be deployed with `WhatsAppBridge` (a binding to a missing Worker/entrypoint fails the deploy). Until a store links, the consumer receives nothing.

**Cost if wrong:** if `ebda-api` lacks the entrypoint at deploy time the ebda-wa deploy fails (no outage; the old version keeps serving). A second consumer later registered on `ebda-wa-events` would silently displace this one and Store events would stop reaching WhatsApp.
