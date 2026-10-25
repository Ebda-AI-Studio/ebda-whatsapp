# Plan: browser sign-in for white-label OIDC tenants (d), shared-number template management (e), integrator server tokens (f)

Branch `feat/oidc-signin-shared-templates`. Binding rules: `CLAUDE.md` and the Global Constraints of `2026-10-24-ebda-whatsapp.md`.

## Item d: sign-in on the tenant's own identity provider (`IDENTITY_MODE=oidc`)

**Goal.** A brand with `accountsUrl: null` and an `oidc` block signs users in with OAuth 2.0 Authorization Code + PKCE (S256) against the tenant's issuer. The page sends the ACCESS token as the bearer; the Worker keeps verifying asymmetric access tokens and refusing ID tokens.

**Design.**
- Brand pack gains `oidc: { issuer, clientId, scope?, audience?, refresh? } | null` (`web/brands/types.ts`). The issuer is data in the brand pack, so the same origin is written into that brand's `_headers`.
- `web/src/data/oidc.ts` (shared, names no brand): `pkcePair` (verifier from 32 random bytes base64url, challenge = base64url(SHA-256)), `discover` (GET `<issuer>/.well-known/openid-configuration`, Zod; `issuer` must equal the configured one exactly; authorization and token endpoints must be https and on the issuer's origin so the CSP lists one origin; `S256` advertised when the list is present), `createOidcTokenProvider` (same `getToken()` shape as `createTokenProvider`), callback handling.
- Transaction (state, nonce, verifier, return path) lives in `sessionStorage` between redirect and callback and is deleted at the callback. Tokens live in module memory only: never localStorage/sessionStorage/cookies/IndexedDB.
- Callback is the SPA route `/auth/callback` (the asset binding already falls back to the SPA outside the Worker-first paths). It refuses an `error` response, missing or mismatching `state`, a token response without `id_token`, and an ID token with wrong `nonce`, `iss`, `aud` (= clientId) or `exp`. Then `history.replaceState` strips `code`/`state`.
- The bearer is always `access_token`; the ID token is read once for the nonce check and dropped.
- Refresh only if the issuer returned a `refresh_token` AND the brand pack says `refresh: true`; otherwise re-authentication (redirect). A failed refresh re-authenticates. A callback error shows an error screen, never an automatic redirect loop.
- CSP: the brand's `_headers` lists the issuer origin exactly in `connect-src` and `form-action`, and no other new host.
- Deploy kit: `deploy.sh`/`check-dist-brand.mjs` refuse when the built brand's OIDC issuer is missing from the CSP or differs from the tenant's `IDENTITY_OIDC_CONFIG` issuer; README gains the vars and steps.

**Files.** `web/brands/types.ts`, `web/brands/demo/*`, `web/src/data/oidc.ts` (+test), `web/src/main.tsx`, `web/src/boot.ts`, `web/src/components/SignInError.tsx`, `web/src/i18n.ts`, `web/vite.config.ts`, `scripts/check-dist-brand.mjs`, `deploy/white-label/*`, `test/oidc-http.test.ts`, `test/assets-config.test.ts`, docs.

**Tests (each seen failing first).** PKCE S256 (RFC 7636 vector); state mismatch refused; nonce checked; token never written to storage; ID token never sent as bearer; discovery issuer mismatch / cross-origin endpoint refused; refresh only when allowed; CSP lists the issuer origin in connect-src and form-action and no other new host. Worker: through the real middleware an access token from a test issuer passes and an ID token is 401.

**Review focus.** Open redirect via return path; one-time state/nonce; code replay; token in URLs/logs; CSP exactness; endpoint-origin pinning.

## Item e: template management for the shared platform number

**Goal.** The platform WABA's templates are platform-owned. Super admins list, sync and submit them with the platform token; store-facing sends on the shared number may only use APPROVED UTILITY or AUTHENTICATION templates of that catalog.

**Design.**
- D1 migration `0013_shared_templates.sql`: `shared_templates` (definitions only, no message content, no phone numbers).
- `src/core/shared/shared-templates.ts`: list, sync (reuses `fetchTemplates` with `META_SYSTEM_TOKEN` and the shared number's WABA), submit (reuses `submitTemplate`), `sharedTemplateSendable`.
- Operator routes behind `requireSuperAdmin` plus the existing session re-check on writes: `GET /operator/shared-templates`, `POST .../sync`, `POST /operator/shared-templates`. Switch off: 404.
- Gate in `sendToMeta` (the single chokepoint for the platform number, once `beforeSharedSend` answers `shared`): refuses anything not APPROVED UTILITY/AUTHENTICATION in the catalog. WA-SHARED-NOCAMP-1 stays and is tested.
- Operator console section "Shared number templates" (ar+en typed maps).

**Tests (each seen failing first).** Staff/owner 403; super admin ok; revoked session fails closed; sync/submit use the platform token on the shared WABA; marketing and unapproved templates refused on shared sends; approved utility/authentication pass; own-number sends untouched.

**Review focus.** Merchant token or workspace template table leaking into the platform path; gate bypass by another send path; D1 holds no content.

## Item f: integrator server tokens (product side)

Built against `docs/contracts/identity-v1.3-integrator-tokens.md` on `origin/docs/identity-v1.3-integrator-tokens` (the current revision is read when f starts and recorded in the ledger), behind `INTEGRATOR_TOKENS_ENABLED` (default off; off = any `client:true` or role `integration` token is 401). Detailed in an addendum to this plan when f starts.

## Out of scope
`src/core/billing/*` and the shared-number join path (another agent). `src/core/api/store-events.ts` is frozen.
