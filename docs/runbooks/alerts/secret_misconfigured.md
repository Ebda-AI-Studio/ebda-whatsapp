# secret_misconfigured (P1)
**Severity:** P1 look today
## What it means
`GET /health` in `src/index.ts` found a secret that is malformed (wrong decoded length) or missing from the `REQUIRED_SECRETS` list (`src/core/secrets-check.ts`). It answers 503 `misconfigured`. Field: `keys` (key NAMES only, never values).
## Impact
`/health` is red, so the deploy verification fails. Features that need the named key may fail. No money moves wrongly, but checkout refuses with 503 while the Kashier secret key is missing.
## Check first
1. Search logs for `{"alert":"secret_misconfigured"...}`; read `keys`.
2. `curl -s <worker-url>/health` and confirm 503 `misconfigured`.
3. Compare with the deployment's `REQUIRED_SECRETS` var in wrangler config.
## Fix
1. Set the named key with `npx wrangler secret put <KEY>`. Never print or paste secret values into chat, tickets or logs.
2. Where the correct value lives: Not documented in code: ask the engineer on call.
## Verify it is resolved
`/health` answers 200 `{"ok":true,"status":"ok"}` and the alert stops.
## Related
docs/runbooks/alerts.md; docs/runbooks/cloudflare-account.md
