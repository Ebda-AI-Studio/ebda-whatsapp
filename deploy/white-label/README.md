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

## Status (2026-10-25)
- Built and checked: the template, the bootstrap script in `--dry-run` (renders valid config with no leftover placeholders; refuses bad input), the generic OIDC verifier (tested).
- Not yet built: **brand packs** (Phase 9.1). `BRAND` is passed through as a var, but the web build and the copy do not read it yet, so every deployment shows the default brand until 9.1 lands. Connectors to the client's systems (webhook, Odoo) are Phase 9.3.
- Not yet run for real: the resource creation and the D1-id lookup (`wrangler d1 info --json`) have only run in dry-run; the first real tenant setup verifies them.
