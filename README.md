# Ebda Chat

Ebda Chat by Ebda AI Studio: WhatsApp commerce, AI agent, campaigns and OTP for Ebda Store merchants and Ebda AI Studio clients.

Cloudflare only: Workers, a Durable Object (SQLite) per workspace, D1, R2, Queues, Workflows, Analytics Engine.

Plan: `docs/plans/2026-10-24-ebda-whatsapp.md`.

Merchant template self-service (create, submit, edit, delete, Meta review status, starter set on connect, shared-number requests): `docs/superpowers/plans/2026-11-14-templates-self-service.md` (tasks 1-12), `docs/messaging-core.md` ("Templates self-service").

WhatsApp catalogue as a store (product cards, cart to order, full catalogue sync): `docs/plans/2026-11-14-whatsapp-catalogue-store.md`, `docs/store-link.md` ("The catalogue as a store inside WhatsApp").

## How a new feature joins the capability registry

Every merchant-facing view, API route and operator action belongs to a capability (lens 192: AI-native, self-service, help guide). The registry is `capabilities/<id>.capability.json`, the config is `capabilities/guard.config.json`, and the schema, rules and guards are the vendored `@ebda/foundation` v0.2.0 modules in `foundation/`.

1. Add `capabilities/<area>.<feature>.capability.json` (copy a neighbour; the id is the file name). `screens`: a web view as `/<view>` (the members of `View` in `web/src/components/Rail.tsx`, e.g. `/inbox`); `api`: exact `METHOD /path` strings relative to `/api/v1` (staff-only routes live under `/operator`); `policy` (`free` | `preview` | `confirm` | `forbidden`: any write, money, template submit or message send is `confirm`); `undo.class`; Arabic (3-6) and English (1-3) example `questions`; operator entries need `operatorReason.code`.
2. A `live` capability that merchants use needs a guide in BOTH `docs/help/ar/NN-<slug>.md` and `docs/help/en/` whose front matter lists `id@version`, and `helpArticle` set to `whatsapp/<slug>`.
3. Run `npx vitest run test/capability-routes.test.ts test/capability-registry.test.ts`. A new offender fails from day one.
4. `capabilities/baselines/*.json` hold today's debt and are shrink-only: fixing an offender means deleting its id in the same PR. The `capability ratchet` workflow fails a PR that adds an id. Never add an id to hide a new offender.
5. Route scopes stay with `test/route-decisions.test.ts` and `test/integrator-tokens.test.ts`; this guard owns capabilities.

