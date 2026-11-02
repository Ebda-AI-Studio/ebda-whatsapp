# Ebda WhatsApp: repo rules

Plan: `docs/plans/2026-10-24-ebda-whatsapp.md` (Global Constraints there are binding). Workspace rules: `../../CLAUDE.md` (Ebda AI Studio).

- Product name is always "Ebda WhatsApp" under Ebda AI Studio; never bare "Ebda".
- No legacy strings anywhere: force, fwb, wbs, forcemediakw (guard: `test/guards.test.ts`).
- `src/core/**` never names Ebda; Ebda-only code and copy live in `src/addons/ebda/**`.
- Cloudflare only (Workers, DO SQLite per workspace, D1, R2, Queues, Workflows, Analytics Engine). Sentry is the only outside error tracker.
- Production only, behind switches; no preview environments. Deploy only after `wrangler whoami` shows the personal account.
- Tenant data is reachable only through `env.WORKSPACE_DO.get(idFromName(workspaceId))`; D1 holds no message content.
- Zod at every edge. Never log raw phone numbers or message bodies.
- Tests: `npm test` (workerd via @cloudflare/vitest-plugin + a node project for guards); `npm run typecheck`; `npm audit` must be 0.
- `foundation/` is vendored from `Whisky-11/ebda-foundation` (`foundation.lock.json`, test `test/foundation-parity.test.ts`). Never edit it here: change the foundation repo, tag, then `sync`. Rulings FDN-VENDOR-1, FDN-TEXT-1.
