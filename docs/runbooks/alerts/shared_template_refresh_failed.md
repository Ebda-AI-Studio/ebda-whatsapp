# shared_template_refresh_failed (P1)
**Severity:** P1 look today
## What it means
`refreshSharedTemplate` in `src/core/shared/shared-templates.ts` asked Meta Graph for the current state of one platform-WABA template and got no usable answer. Fields: `name` (the template) and `reason`: `token_unavailable` (no platform token, `META_SYSTEM_TOKEN`) or `meta_unavailable` (Graph failed or was unreachable).
## Impact
The `shared_templates` catalog row for that template is left exactly as it was (it is never loosened on a failed read). A template Meta just approved stays unsendable from the shared number until a fresh read succeeds. Tightening (reject, pause) is unaffected. No money or consent effect.
## Check first
1. Search the logs for `{"alert":"shared_template_refresh_failed"...}` and read `reason`.
2. `reason=token_unavailable`: confirm the platform token secret is set (name only, never print it): `wrangler secret list`.
3. `reason=meta_unavailable`: check Meta status and the logs for the Graph error around the same time.
4. `GET /api/v1/operator/shared-templates` shows the stored status of each template (docs/shared-number.md#platform-templates-operator).
## Fix
1. Fix the cause (set the missing platform token, or wait out a Meta outage).
2. Run `POST /api/v1/operator/shared-templates/sync` (super admin). It re-reads every template from Meta and replaces the catalog in one batch; a failed page changes nothing (503).
3. The system does not retry this refresh by itself: the next template webhook from Meta for that template triggers another read.
## Verify it is resolved
The sync returns `{ upserted, removed }` and `GET /api/v1/operator/shared-templates` shows the expected status. No new `shared_template_refresh_failed` line appears.
## Related
docs/shared-number.md#platform-templates-operator, docs/shared-number.md#alerts-structured-logs, shared_sweep_failed
