# Identity contract v1.3 (DRAFT): integrator server tokens

Status: **draft for review** by the Store identity agent (accounts.ebda.app owner). Additive to identity contract v1.2 (`business/ebda/plans/2026-10-24-ebda-identity-token-contract.md`); nothing in v1.2 changes. v1.2 §"what v1.x does NOT cover" lists exactly this flow as missing.

## Why
A merchant's own server (an ERP, a custom checkout, Odoo, a script) must call the Ebda WhatsApp API without a person signing in. Today every token comes from a browser session (`GET /token?aud=`), so that is impossible.

## Model
- An **integration client** belongs to ONE store and ONE product audience. It is created, listed, rotated and revoked by that store's **owner** (never staff, never a platform admin acting silently).
- Credentials: `client_id` (`cli_<26 chars>`, public) + `client_secret` (32 random bytes, base64url, shown ONCE at creation or rotation). accounts.ebda.app stores only `SHA-256(secret)`; a high-entropy random secret needs no slow hash, and comparison is constant-time. At most two live secrets per client during a rotation; the old one has an expiry.
- **Scopes** (space-separated, least privilege, chosen at creation): `conversations:read`, `messages:send`, `templates:read`, `contacts:read`, `contacts:write`, `campaigns:read`, `orders:events` (reserved). Unknown scopes are refused at creation.

## Token endpoint (accounts.ebda.app)
`POST https://accounts.ebda.app/oauth/token`, `Content-Type: application/x-www-form-urlencoded`
- `grant_type=client_credentials`, `audience=whatsapp`, optional `scope=` (a subset of the client's scopes; default = all of them)
- client authentication: HTTP Basic (`client_secret_basic`, RFC 6749 §2.3.1). Secrets in the body are refused.
- Not credentialed CORS: browsers must not call it (no `Access-Control-Allow-Origin`).
- Answer (RFC 6749 §5.1): `{ "access_token", "token_type": "Bearer", "expires_in": 600, "scope" }`. **No refresh token.**
- Errors: RFC 6749 §5.2 (`invalid_client` 401, `invalid_scope`, `unauthorized_client` for a revoked or other-audience client). Rate limit per client_id and per IP (e.g. 60 tokens/hour/client), `429` with `Retry-After`.

## Access token claims (same signing key, JWKS and verifier as v1.2)
| Claim | Value |
|---|---|
| header | `alg: ES256`, `kid`, `typ: at+jwt` |
| `iss` | `https://accounts.ebda.app` |
| `aud` | `whatsapp` (one audience; the client's own) |
| `sub` | the client id `cli_…` (never a user id) |
| `sid` | the client id as well, so `Accounts.isRevoked(sid)` covers revocation with no new RPC |
| `stores` | exactly one: `[{ "id": "<storeId>", "role": "integration" }]` |
| `scope` | the granted scopes |
| `client` | `true` |
| `iat`, `nbf`, `exp` | 10 minutes |
| absent | `pa`, `auth_time`, `email`. An integration token is never a platform admin and never a person. |

## Product side (Ebda WhatsApp)
- The verifier accepts `role: "integration"` only together with `client: true` and a `scope`.
- Every route declares the scope it needs. Integration tokens are refused (403) on owner-only and person-only surfaces: staff changes, numbers connect or disconnect, wallet top-ups and refunds, package checkout, data export or erasure, bot and agent settings, connectors, and the operator console.
- Because a machine token is not tied to an interactive session, EVERY request made with an integration token checks `Accounts.isRevoked(sid)`, not only sensitive ones. It fails closed (503) when the binding is down. A per-isolate cache of at most 30 s is allowed, BOUNDED-stale class, documented at the cache site.
- The audit line on every write carries `{ clientId, storeId, scope }` (no message content, no phone numbers).

## Management (accounts.ebda.app, owner session)
- `GET/POST /stores/:storeId/clients`, `POST /stores/:storeId/clients/:id/rotate`, `DELETE /stores/:storeId/clients/:id` (revoke): owner of that store only (checked against the Store's ownership, as the existing `stores` claim is), with the v1.2 MFA rules for sensitive changes.
- **Audit trail** (append-only, on accounts.ebda.app): created, rotated, revoked, token issued (one row per issuance with client id, IP prefix, scope; aggregated if very frequent), failed authentication. Shown to the owner (last used, last IP prefix).
- Revocation is immediate for new tokens. Existing tokens die at their 10-minute `exp`, or at once wherever `isRevoked` is checked (every integration request in Ebda WhatsApp).
- Store or user erasure (v1.1 `eraseUser`) deletes the store's clients and secrets.

## Not in v1.3
- Per-user delegation (OAuth authorization-code for third-party apps acting for a person).
- Integrations for the Store API (it keeps its own merchant API keys).
- Webhook signing keys (unchanged: connectors use their own HMAC secrets).

## Tests to pin (both repos)
A fixed client token vector, signed with the shared test JWKS, accepted with `role: integration` and the scope. Refused: an integration token on an owner-only route, a token without `client: true`, `pa` on a client token, and a revoked client (`isRevoked` true).
