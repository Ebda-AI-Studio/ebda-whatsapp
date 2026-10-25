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
  The format is checked at boot (`src/core/identity/oidc.ts`): https only, asymmetric signatures only, at least one role mapped. A broken config stops the Worker instead of letting anyone in.

## Steps
1. `npx wrangler login` as the client's user; `npx wrangler whoami` must list their account id.
2. Dry run first, then for real (it asks you to retype the account id):
   ```
   deploy/white-label/bootstrap.sh --account <id> --prefix client-wa --brand <brand> --identity oidc --url https://wa.client.example --dry-run
   deploy/white-label/bootstrap.sh --account <id> --prefix client-wa --brand <brand> --identity oidc --url https://wa.client.example
   ```
   It creates D1 `<prefix>-platform`, R2 `<prefix>-media` and `<prefix>-backups` (30-day lifecycle), queues `<prefix>-send` and `-dlq`,
   renders `deploy/white-label/wrangler.<prefix>.jsonc` (git-ignored) and applies the D1 migrations.
3. Secrets: the script prints the list; set each with `npx wrangler secret put <NAME> -c deploy/white-label/wrangler.<prefix>.jsonc`. Keys are generated fresh per tenant, never copied from another deployment.
4. Build and deploy, then verify with `scripts/verify-prod.mjs` (all printed by the script). Then the manual checks in `docs/launch/README.md` § 13.
5. Route the hostname to the Worker (Cloudflare dashboard → Workers → the Worker → Domains & Routes) and point the client's Meta webhook to `https://<host>/meta/webhook`.

## Adding a client brand
1. **Server pack** `src/addons/<brand>/pack.ts` (copy `src/addons/demo/pack.ts`): auto reply, opt-in words, starter templates, the AI agent's persona and words; no `storeLink` unless the client runs Ebda Store. Register it in `src/brand.ts` (`BRANDS`). The deployment's `BRAND` var selects it; an unknown name stops the Worker.
2. **Web brand** `web/brands/<brand>/` (copy `web/brands/demo/`): `brand.ts` (product name, mark, apple icon, accounts URL or null, help base or null, store name or null), `tokens.css` (colour overrides of the default tokens), `public/` (its mark, favicon and `_headers`; keep the base CSP and add only the client's own hosts). `BRAND=<brand> npm run build:web` builds it; an unknown brand fails the build.
3. Guards keep the seam honest: shared web code and `src/core` name no brand, `src/index.ts` reaches brand code only through `src/brand.ts`, every brand's `_headers` keeps the base policy, and the demo build contains no suite name.

## Status (2026-10-25)
- Built and checked: brand packs (server registry + web build per brand; the demo build carries no suite name), the template, the bootstrap script in `--dry-run` (renders valid config with no leftover placeholders; refuses bad input), the generic OIDC verifier (tested).
- In progress: connectors to the client's systems (webhook, Odoo), Phase 9.3.
- Not built: sign-in for a brand on its own identity provider is verified on the API side (OIDC), but the page has no login screen for it yet; such a tenant's portal must hand the page a token (to design with the first client).
- Not yet run for real: the resource creation and the D1-id lookup (`wrangler d1 info --json`) have only run in dry-run; the first real tenant setup verifies them.
