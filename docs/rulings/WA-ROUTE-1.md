# Ruling WA-ROUTE-1

**Decision:** ebda-wa declares an explicit zone route `wa.ebda.app/*` in addition to its custom domain.

**Evidence (2026-10-28 GO-1):** after the first production deploy, wa.ebda.app answered with the Store's 404 page. The ebda.app zone carries `*.ebda.app/*` and `*/*` routes to ebda-web, and those zone routes took precedence over the ebda-wa custom domain. `wrangler tail ebda-wa` showed no requests. Adding the route `wa.ebda.app/*` -> ebda-wa (CF API) made /health answer 200 with commit 4faa4c6, and verify-prod passed, including buyer key parity and the live cron.

**Cost if wrong:** a later deploy could drop the route and wa.ebda.app would silently serve the Store 404 again. verify-prod (health commit) catches that on the next deploy.
