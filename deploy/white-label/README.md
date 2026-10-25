# White-label deploy kit

Runs the WhatsApp product for a client (first: Khawarz, Kuwait) inside **the client's own Cloudflare account**, with the client's
brand and, if they have one, the client's own identity provider. Sales-led: the operator creates the tenant and assigns its package;
there is no self-serve checkout.

## What you need from the client
- Cloudflare account id, and a user on it you can log in as (`npx wrangler login`) with Workers, D1, R2, Queues and Workers AI rights.
- The public hostname for the inbox (e.g. `wa.client.example`), added to that Cloudflare account.
- Their Meta Business portfolio, verified, with their own Meta app (or our app as Tech Provider: their WhatsApp Business Account connects through Embedded Signup like any merchant).
- Identity: either they sign in through accounts.ebda.app (`--identity ebda`) or through their own OpenID Connect provider (`--identity oidc`): issuer URL, JWKS URL, audience, and which role names mean owner and staff. Example `IDENTITY_OIDC_CONFIG`:
  ```json
  { "issuer": "https://login.client.example/realms/main", "jwksUrl": "https://login.client.example/realms/main/protocol/openid-connect/certs",
    "audience": "wa-client", "stores": { "fixed": "<the tenant's workspace uuid>" },
    "role": { "claim": "realm_access.roles", "owner": ["manager"], "staff": ["frontdesk"] } }
  ```
  Browser sign-in also needs the provider to know the page: register a **public client** (no secret) with the Authorization Code flow and PKCE (S256), redirect URI `https://<host>/auth/callback` (exact), and the same audience the Worker expects on the ACCESS token (some providers need an `audience`/resource setting on the client or an API scope). Send the client id and the issuer to us; they go in the brand pack (see "Adding a client brand", step 2), never in a secret.
  The format is checked at boot (`src/core/identity/oidc.ts`): https only, asymmetric signatures only, at least one role mapped. A broken config stops the Worker instead of letting anyone in.

## Steps
1. `npx wrangler login` as the client's user; `npx wrangler whoami` must list their account id.
2. Dry run first, then for real (it asks you to retype the account id):
   ```
   deploy/white-label/bootstrap.sh --account <id> --prefix client-wa --brand <brand> --identity oidc --url https://wa.client.example --dry-run
   deploy/white-label/bootstrap.sh --account <id> --prefix client-wa --brand <brand> --identity oidc --url https://wa.client.example
   ```
   It creates D1 `<prefix>-platform`, R2 `<prefix>-media` and `<prefix>-backups` (30-day lifecycle), queues `<prefix>-send` and `-dlq`,
   renders `deploy/white-label/wrangler.<prefix>.jsonc` (git-ignored) and applies the D1 migrations. The suite identity endpoints (`IDENTITY_ISSUER`, `IDENTITY_JWKS_URL`, `IDENTITY_AUDIENCE`) are written only with `--identity ebda`; an `oidc` tenant's config carries none of them.
3. Secrets: the script prints the list; set each with `npx wrangler secret put <NAME> -c deploy/white-label/wrangler.<prefix>.jsonc`. Keys are generated fresh per tenant, never copied from another deployment.
4. Build the brand, deploy, verify (all printed by the script):
   ```
   BRAND=<brand> npm run build:web
   deploy/white-label/deploy.sh wrangler.<prefix>.jsonc
   node scripts/verify-prod.mjs --base https://<host> --expect "$(git rev-parse --short HEAD)" --brand <brand>
   ```
   The web build stamps `web/dist/brand.json` with its brand. `deploy.sh` reads the brand from the rendered config and **refuses** (before any `wrangler deploy`) when `web/dist` was built for another brand or not stamped, because `web/dist` is shared by every tenant and a stale build of the suite brand would otherwise be served under the client's name. `verify-prod.mjs --brand` repeats the proof from outside: the live `/brand.json` must name the brand and, for a white-label brand, the page's CSP must contain no `ebda.app` host. `/health` reports the brand pack's service name. Then the manual checks in `docs/launch/README.md` § 13.
   **Sign-in on the client's own provider (`--identity oidc`).** The page signs in with OAuth 2.0 Authorization Code + PKCE against `issuer` from `web/brands/<brand>/brand.ts` (`oidc: { issuer, clientId, audience?, refresh? }`). Rules the kit checks: the issuer string must equal `issuer` in `IDENTITY_OIDC_CONFIG`; the provider's discovery document (`<issuer>/.well-known/openid-configuration`) must name that issuer, advertise `S256` (when it lists methods) and keep its authorization and token endpoints on the issuer's origin; the brand's `_headers` lists that one origin, exactly, in `connect-src` and `form-action` and no other new host. `deploy.sh` stops when `web/dist/_headers` does not; run it with `OIDC_ISSUER=<issuer from IDENTITY_OIDC_CONFIG> deploy/white-label/deploy.sh ...` to also stop when the brand's issuer differs from the Worker's. The token stays in the page's memory (never `localStorage`); a reload signs in again, silently when the provider still has its own session. A refresh token is used only when the provider issues one and the brand sets `refresh: true` (then `offline_access` is requested); otherwise the page signs in again when the access token expires. The ID token is used once to check the nonce and is never sent to the API. **Sign-out:** the rail has a sign-out button that clears the page's tokens and sends the browser to the provider's `end_session_endpoint` (from discovery, same origin as the issuer; others are ignored) with `id_token_hint` (kept in memory only), `client_id` and `post_logout_redirect_uri=https://<host>/`. Register `https://<host>/` as an allowed post-logout redirect URI on the client at the provider. A provider with no end-session endpoint gets a local sign-out and the page tells the person to sign out at the provider too (otherwise the provider's own session signs the next person in).
5. Route the hostname to the Worker (Cloudflare dashboard → Workers → the Worker → Domains & Routes) and point the client's Meta webhook to `https://<host>/meta/webhook`.

## Adding a client brand
1. **Server pack** `src/addons/<brand>/pack.ts` (copy `src/addons/demo/pack.ts`): auto reply, opt-in words, starter templates, the AI agent's persona and words; no `storeLink` unless the client runs Ebda Store. Register it in `src/brand.ts` (`BRANDS`). The deployment's `BRAND` var selects it; an unknown name stops the Worker.
2. **Web brand** `web/brands/<brand>/` (copy `web/brands/demo/`): `brand.ts` (product name, mark, apple icon, accounts URL or null, `oidc` issuer + public client id or null (a brand has exactly one of the two), help base or null, store name or null), `tokens.css` (colour overrides of the default tokens), `public/` (its mark, favicon and `_headers`; keep the base CSP and add only the client's own hosts: an OIDC brand adds its issuer origin to `connect-src` and `form-action`). `BRAND=<brand> npm run build:web` builds it; an unknown brand fails the build.
3. Guards keep the seam honest: shared web code and `src/core` name no brand, `src/index.ts` reaches brand code only through `src/brand.ts`, every brand's `_headers` keeps the base policy, and the demo build contains no suite name.

## Status (2026-10-25)
- Built and checked: brand packs (server registry + web build per brand; the demo build carries no suite name), connectors to the client's systems (signed webhook + Odoo; tested against fakes, see below and `docs/connectors.md`), the template, the bootstrap script in `--dry-run` (renders valid config with no leftover placeholders; refuses bad input), the generic OIDC verifier (tested).
- Not yet run against a real client system: connectors (no real Odoo or client endpoint yet; Odoo field names marked NOT VERIFIED in `docs/connectors.md`).
- Built, tested against a fake provider only: browser sign-in for a brand on its own identity provider (Authorization Code + PKCE, `web/src/data/oidc.ts`). Not yet run against a real provider (Keycloak, Entra, Auth0...): the first client verifies discovery, the redirect-uri registration and the audience on the access token.
- Not yet run for real: the resource creation and the D1-id lookup (`wrangler d1 info --json`) have only run in dry-run; the first real tenant setup verifies them.

## Connecting the client's own systems (connectors)
The agent can call the client's webhook or Odoo (draft quotations, stock, calendar bookings). The owner sets this up in the product after deploy (`PUT /connectors/:id`, secrets are encrypted per workspace); deploy-time you only need `AGENT_SECRETS_KEY` (already in the secrets list) and, if you want connectors limited to named hosts, `AGENT_ALLOWED_HOSTS`. Contract, signature verification, Odoo setup and limits: `docs/connectors.md`.
