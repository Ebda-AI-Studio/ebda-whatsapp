# binding_missing (P1)
**Severity:** P1 look today
## What it means
`GET /health` in `src/index.ts` found a required Worker binding absent at runtime (`REQUIRED_BINDINGS` in `src/core/secrets-check.ts`; today `VECTORIZE`, the AI knowledge-base index `ebda-wa-kb`). It answers 503 `misconfigured`. Field: `bindings` (binding NAMES only).
## Impact
`/health` is red, so the deploy verification fails. Without `VECTORIZE` the AI agent would answer without its knowledge base and catalog search; the guard exists so that is never silent.
## Check first
1. Search logs for `{"alert":"binding_missing"...}`; read `bindings`.
2. Confirm `wrangler.jsonc` still has `"vectorize": [{ "binding": "VECTORIZE", "index_name": "ebda-wa-kb" }]`.
3. `npx wrangler vectorize list` (account 69188202efc4df480140dd76545aa3ab) shows `ebda-wa-kb`.
## Fix
1. Missing from the config: restore the binding and redeploy (the deploy command in Workers Builds (a push to main redeploys)).
2. Index missing on the account: `npx wrangler vectorize create ebda-wa-kb --dimensions=1024 --metric=cosine`, then redeploy. Dimensions and metric cannot be changed later; a wrong index must be deleted and recreated (derived data: the catalog is re-embedded by the nightly pass; merchants re-save their FAQ text to rebuild its chunks).
## Verify it is resolved
`/health` answers 200 `{"ok":true,"status":"ok"}` and the alert stops.
## Related
docs/ai-agent.md; docs/rulings/WA-VECTORIZE-1.md; docs/runbooks/alerts.md
