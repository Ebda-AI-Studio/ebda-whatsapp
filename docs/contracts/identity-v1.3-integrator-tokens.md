# Identity contract v1.3 (DRAFT r2): integrator server tokens

Status: **draft r2.** It folds in the identity-side review on PR #10 (comment 6398105328, items 1–10 + the pinned tests) and awaits approval by the accounts.ebda.app owner. Additive to identity contract v1.2 (`business/ebda/plans/2026-10-24-ebda-identity-token-contract.md`); nothing in v1.2 changes. v1.2 §"what v1.x does NOT cover" lists exactly this flow as missing.

## Why
A merchant's own server (an ERP, a custom checkout, Odoo, a script) must call the Ebda Chat API without a person signing in. Today every token comes from a browser session (`GET /token?aud=`), so that is impossible.

## Model
- One generic table on accounts.ebda.app: `clients(id, store_id, audience, name, scopes, created_by, created_at, revoked_at)` plus `client_secrets(client_id, slot, hmac, created_at, expires_at)`. **Audience is fixed at creation**, and v1.3 ships only `audience = whatsapp`. The Store reuses the same table later with `audience = store` (see "Not in v1.3"); there is no second key system.
- An integration client belongs to ONE store and ONE audience. It is created, listed, rotated and revoked by that store's **owner** (see Management). It can never be created for a platform audience.
- Credentials:
  - `client_id`: `cli_<26 chars>`, public.
  - `client_secret`: `ebs_` + 32 random bytes in base64url. The prefix lets secret scanning recognise a leak. It is shown ONCE, in the create or rotate response, which carries `Cache-Control: no-store`.
- **At rest:** `HMAC-SHA256(CLIENT_SECRET_PEPPER, secret)`. The pepper is a Worker secret, separate from `MFA_KEY` and the signing key, so a D1-only leak cannot be tested offline. Comparison is constant-time; an unknown `client_id` still runs a dummy compare, so timing reveals nothing.
- **Scopes:** a per-audience registry in ONE file (`audience → allowed scopes`), validated at creation. For `whatsapp`: `conversations:read`, `messages:send`, `templates:read`, `contacts:read`, `contacts:write`, `campaigns:read`. `orders:events` is reserved and **unissuable**, so creation refuses it.

## Token endpoint (accounts.ebda.app), the ONLY mint
`POST https://accounts.ebda.app/oauth/token`, `Content-Type: application/x-www-form-urlencoded`
- `grant_type=client_credentials`, `audience=whatsapp`, optional `scope=`. The scope must be a subset of the client's; the default is all of them.
- **Audience:** the `audience` parameter must equal `clients.audience`, otherwise `unauthorized_client`. `aud=store` is never issuable to a client in v1.3.
- **Browsers:** a request carrying an `Origin` header is refused. Browsers must never call this endpoint, and there is no CORS.
- **Client authentication:** HTTP Basic only (`client_secret_basic`, RFC 6749 §2.3.1). A secret in the body is refused.
- **No RPC mint (ID-12):** the `Accounts` WorkerEntrypoint exposes NO method that mints a client token.
- **Answer** (RFC 6749 §5.1): `{ "access_token", "token_type": "Bearer", "expires_in": 600, "scope" }` with `Cache-Control: no-store`. There is no refresh token.
- **Failures:** ONE uniform `invalid_client` 401 for an unknown id, a wrong secret or a revoked client, with no distinction between them. `invalid_scope` covers bad scopes. `unauthorized_client` covers an audience mismatch.
- **Rate limits** use the accounts limiter (Durable Object, atomic counters):
  - 60 successful issues/hour per client;
  - a failed-auth limit per (client_id, IP prefix), so hammering a client id from one IP never locks out the real client calling from elsewhere. The client is never locked globally.
  - Over a limit: `429` + `Retry-After`.

## Access token claims (same signing key, JWKS and verifier as v1.2)
| Claim | Value |
|---|---|
| header | `alg: ES256`, `kid`, `typ: at+jwt` |
| `iss` | `https://accounts.ebda.app` |
| `aud` | the client's audience (`whatsapp`) |
| `sub` | the client id `cli_…` (never a user id) |
| `sid` | the client id |
| `jti` | a unique id per token (for the audit row and any later denylist) |
| `stores` | exactly one: `[{ "id": "<storeId>", "role": "integration" }]` |
| `scope` | the granted scopes |
| `client` | `true` |
| `iat`, `nbf`, `exp` | 10 minutes |
| never present | `pa`, `auth_time`, `email`, any `stores` role other than `integration` |

A PERSON token never carries `client` or `role: "integration"`. Every product's verifier rejects a token that has `client: true` with `pa`, `auth_time` or a person role, and also rejects a person token that has `client`.

## Revocation
- `Accounts.isRevoked(sid)`: for a `cli_` id it consults the clients table (`revoked_at` set, or the store deleted) instead of sessions. Unknown counts as revoked.
- Revocation is by client row, not by secret. A **rotation does NOT revoke live tokens**; only an explicit revoke (or store deletion) does. Tokens minted before a rotation stay valid until their `exp`.

## Rotation
- At most two live secrets. Rotate creates the new one and sets `expires_at` on the old one: 24 h by default, owner-chosen from 0 to 7 days (0 = revoke the old one now).
- A second rotate while two are live is refused (409) until the old one expires or is revoked.
- Both secrets authenticate to the SAME client row. The issuance audit records `secret_slot`, so the owner sees when the old one stopped being used.

## Management API (accounts.ebda.app, owner session)
- `GET/POST /stores/:storeId/clients`, `POST /stores/:storeId/clients/:id/rotate`, `DELETE /stores/:storeId/clients/:id` (revoke).
- Ownership comes from the **membership table in D1 at request time**, never from the bearer's `stores` claim (claims can be up to 15 min stale).
- Create, rotate and revoke require a **fresh second factor**: session `auth_time` ≤ 10 min, with `amr` containing otp or hwk (the v1.2 step-up). Cookie sessions also pass the Origin allowlist / CSRF check.
- Staff and platform admins get 403. There is no silent platform-admin path (ID-12/ID-15).
- `created_by` is recorded. Removing or demoting the owner who created a client does not kill it; the new owner sees it and can revoke it.

## Audit and erasure
- **Retention:** issuance rows (client id, `jti`, secret slot, IP prefix, scope, time) are kept 90 days and pruned by a cron job. Created, rotated, revoked and failed-auth rows are kept for the life of the store. The owner sees last used and last IP prefix.
- **Store deletion** deletes the store's clients, secrets and issuance rows through a store-delete RPC hook on `Accounts`, which the Store's existing delete-store flow calls within its compensating-rollback context. People are covered by v1.1 `eraseUser`.

## Product side (Ebda Chat)
- The verifier accepts `role: "integration"` only with `client: true` and a `scope`, and with no `pa`, `auth_time` or `email`.
- Every route declares the scope it needs in one map. A test walks every route, so a new route without a scope decision fails CI.
- Integration tokens get 403 on owner-only and person-only surfaces:
  - staff changes;
  - number connect and disconnect;
  - wallet top-ups and refunds;
  - package checkout;
  - data export and erasure;
  - bot and agent settings, and connectors;
  - the operator console.
- EVERY request with an integration token checks `Accounts.isRevoked(sid)` and fails closed (503) when the binding is down. A per-isolate cache of at most 30 s is allowed, BOUNDED-stale, documented at the cache site.
- The audit line on every write: `{ clientId, jti, storeId, scope }`, with no message content and no phone numbers.
- Behind `INTEGRATOR_TOKENS_ENABLED` (default off). While off, any `client: true` token is refused (401).

## Not in v1.3
- `audience = store` clients (the Store's MCP/agent keys): **planned, same table**, with their own narrow scopes and never owner-capable. Until then the Store keeps its current merchant API keys; no parallel format will be added.
- Per-user delegation (authorization-code for third-party apps acting for a person).
- Webhook signing keys (unchanged: connectors use their own HMAC secrets).

## Pinned tests (both sides, shared test JWKS)
1. A fixed client-token vector is accepted with `role: integration` and its scope.
2. Refused:
   - a token without `client: true`, or with `pa`;
   - an `aud` mismatch (`unauthorized_client`);
   - a request carrying `Origin`;
   - a revoked client or a deleted store (`isRevoked` true).
3. Rotation: the old secret works until its expiry, then 401; tokens minted before the rotation stay valid.
4. Rate limits: the 61st issue in an hour gets 429. N wrong secrets from one IP do not block the real client calling from another IP.
5. Timing: an unknown id takes the same path as a known one (assert the dummy compare runs).
6. Product: an integration token on an owner-only route gets 403, and the route-scope walk is complete.

## API rate limits (W2-ABUSE, F4)
After a token is verified, every `/api/v1/stores/:storeId/*` request spends a token from a per-workspace bucket (20/s, burst 100) and, for an integrator token, first from a per-CLIENT bucket (5/s, burst 30; keyed by the client id, so re-minting a token does not reset it). Over a limit: `429 {"error":"rate_limited"}` with `Retry-After`. Platform operators are not limited by a store's bucket. The buckets live in each isolate (bounded-stale; see `src/core/api-rate.ts`).
