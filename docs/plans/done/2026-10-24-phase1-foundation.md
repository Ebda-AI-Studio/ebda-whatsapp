# Ebda WhatsApp Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The parts of the foundation that need no Meta access: CI, the shared customer key, one-account sign-in, error tracking, nightly backups with a restore drill, and erasure.

**Architecture:** Same worker `ebda-wa`. New core modules stay brand-neutral (`src/core/identity/verifier.ts` is an interface; the accounts.ebda.app implementation lives in `src/addons/ebda/identity.ts`). Backups are a per-workspace DO alarm (daily, never shorter than 1 h) writing NDJSON + manifest to R2. Erasure is a DO method plus an operator API route.

**Tech Stack:** as the program plan, plus `jose` 6.2.12 (ES256/JWKS on workerd) and `@sentry/cloudflare` 11.7.0.

**Spec:** `docs/plans/done/2026-10-24-ebda-whatsapp.md` (Phase 1 row + Global Constraints), `~/Desktop/projects/Ebda-AI-Studio/business/ebda/plans/2026-10-24-ebda-identity-token-contract.md` (identity v1), `…/2026-10-24-ebda-whatsapp-store-contract.md` §6 (buyerKey + pinned vector).

## Global Constraints
- Everything in the program plan's Global Constraints.
- Identity v1: ES256 only; `iss` exactly `https://accounts.ebda.app`; `aud` exactly `whatsapp`; `exp`/`nbf` with ≤60 s skew; JWKS cached ≤10 min with one refetch on an unknown `kid`; request `storeId` must be in `stores[].id` else 403; `pa: "super_admin"` is the only platform role.
- buyerKey: `HMAC-SHA256(SUITE_BUYER_KEY_SECRET, E.164)` lowercase hex; pinned vector secret `ebda-suite-buyer-key-test-v1`, `+201001234567` → `e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd`.
- No PII to Sentry: no request bodies, no phone numbers, no message text.
- Backups: row-count + sha256 per table in the manifest; restore must reproduce both exactly.

## Review Focus
1. **Arabic-Indic and spaced phone input** (`٠١٠٠١٢٣٤٥٦٧`, `+20 100 123 4567`, `0020…`) normalises to the same E.164 → Task 1.2 tests.
2. **A token signed with HS256 using the public key as the secret** (alg confusion) is rejected → Task 1.3 test `rejects HS256`.
3. **JWKS rotation:** a token whose `kid` is new triggers exactly one refetch; a garbage `kid` cannot make us refetch on every request → Task 1.3 test `refetches once on unknown kid`.
4. **Erasure leaves nothing behind:** contact, conversation, messages, status events and R2 bodies all go → Task 1.6 test per surface.
5. **A backup taken while messages arrive** is internally consistent (counts in the manifest equal the rows in the files) → Task 1.5 test.

---

### Task 1.1: CI and secret scanning

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/gitleaks.yml`, `.gitleaks.toml`.

- [ ] **Step 1:** `ci.yml` on `pull_request` + `push: main`; `concurrency: { group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}, cancel-in-progress: ${{ github.event_name == 'pull_request' }} }`; `permissions: contents: read`; one job `check` with `runs-on: ${{ fromJSON(vars.EBDA_RUNS_ON || '"ubuntu-latest"') }}`, `timeout-minutes: 15`, steps: checkout (pinned SHA as in ebda-store), setup-node 22 with `cache: ${{ vars.EBDA_RUNS_ON == '' && 'npm' || '' }}` (never the remote cache on Umbra), `npm ci`, `npm run typecheck`, `npm test`, `npm audit --audit-level=low`.
- [ ] **Step 2:** `gitleaks.yml` copied from ebda-store's (gitleaks 8.21.2 CLI, `--redact`), `.gitleaks.toml` extending the default rules with an allowlist for `test/fixtures/**` and the pinned test secret string.
- [ ] **Step 3: Verify:** `npx --yes action-validator` is not available offline, so verify by pushing the branch: both workflows run on the PR; `gh pr checks` shows `check` and `Scan for leaked secrets` green.
- [ ] **Step 4: Commit** `ci: typecheck, tests, audit and gitleaks on the Umbra runner pattern`.

### Task 1.2: E.164 normaliser and buyerKey

**Files:** Create `src/core/phone.ts`, `src/core/buyer-key.ts`, `test/phone.test.ts`.

**Interfaces:** Produces `normaliseE164(input: string, defaultCountry?: '20'): string | null` and `buyerKey(secret: string, e164: string): Promise<string>`.

- [ ] **Step 1: Failing tests**
```ts
it.each(['01001234567', '201001234567', '+20 100 123 4567', '٠١٠٠١٢٣٤٥٦٧', '00201001234567', '+201001234567', '(+20) 100-123-4567'])('%s → +201001234567', (i) => expect(normaliseE164(i)).toBe('+201001234567'));
it('keeps a foreign number', () => expect(normaliseE164('+965 5000 1234')).toBe('+96550001234'));
it.each(['', 'abc', '123', '+2010012345678901'])('rejects %s', (i) => expect(normaliseE164(i)).toBeNull());
it('buyerKey matches the pinned suite vector', async () => expect(await buyerKey('ebda-suite-buyer-key-test-v1', '+201001234567')).toBe('e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd'));
it('buyerKey refuses a non-E.164 input', async () => expect(buyerKey('s', '01001234567')).rejects.toThrow());
```
- [ ] **Step 2:** `npx vitest run test/phone.test.ts` → FAIL.
- [ ] **Step 3:** Implement: map Arabic-Indic (U+0660–0669) and Persian (U+06F0–06F9) digits, strip spaces/dashes/parentheses, `00` → `+`, a leading national `0` with default country 20 → `+20` + rest, bare `20…` of Egyptian length (12 digits) → `+`; result must match `/^\+[1-9]\d{7,14}$/`. `buyerKey` uses WebCrypto HMAC, throws unless the input matches that regex.
- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat: E.164 normaliser and suite buyerKey (pinned vector)`.

### Task 1.3: One-account sign-in (identity v1)

**Files:** Create `src/core/identity/verifier.ts`, `src/addons/ebda/identity.ts`, `src/core/identity/middleware.ts`, `test/identity.test.ts`, `test/helpers/issuer.ts`. Modify `src/index.ts` (route `GET /api/v1/stores/:storeId/me`), `src/env.ts` (`IDENTITY_JWKS_URL`, `IDENTITY_ISSUER`, `IDENTITY_AUDIENCE` vars).

**Interfaces:**
- `type Principal = { userId: string; sessionId: string; stores: { id: string; role: 'owner' | 'staff' }[]; superAdmin: boolean }`
- `interface IdentityVerifier { verify(token: string): Promise<Principal> }` (throws `IdentityError` with `status: 401 | 403`)
- `createEbdaAccountsVerifier(opts: { jwksUrl: string; issuer: string; audience: string; fetchJwks?: typeof fetch }): IdentityVerifier`
- `requireStoreAccess(getVerifier: (env: Env) => IdentityVerifier)` Hono middleware: reads `Authorization: Bearer`, verifies, checks `:storeId` ∈ `stores` (super admin passes), sets `c.var.principal`.

- [ ] **Step 1: Failing tests** (`test/helpers/issuer.ts` generates an ES256 key pair with `jose.generateKeyPair('ES256')`, exports a JWKS and `mint(claims, opts)`; the verifier gets a stub `fetchJwks` counting calls):
`accepts a valid token and returns the principal` · `rejects HS256 (alg confusion)` · `rejects alg none` · `rejects a wrong issuer` · `rejects a wrong audience (store)` · `rejects an expired token beyond 60 s skew` · `accepts 30 s clock skew` · `refetches once on unknown kid` (rotate key → 2 JWKS fetches total, then a garbage kid within the cooldown → still 2) · `route: 401 without a token` · `route: 403 when storeId is not in stores` · `route: 200 for a super admin on any store`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement with `jose.createRemoteJWKSet(new URL(jwksUrl), { cacheMaxAge: 600_000, cooldownDuration: 30_000, [customFetch]: fetchJwks })` and `jwtVerify(token, jwks, { algorithms: ['ES256'], issuer, audience, clockTolerance: 60, typ: 'at+jwt' })`; Zod-parse the payload (`sub` uuid, `sid` string, `stores` array, `pa` optional literal). Vars default in `wrangler.jsonc`: `IDENTITY_ISSUER=https://accounts.ebda.app`, `IDENTITY_JWKS_URL=https://accounts.ebda.app/.well-known/jwks.json`, `IDENTITY_AUDIENCE=whatsapp`. The service is not built yet, so prod requests fail closed (401) until it exists.
- [ ] **Step 4:** run → PASS. **Step 5: Commit** `feat: identity v1 verifier (accounts.ebda.app, aud whatsapp) + store access middleware`.

### Task 1.4: Error tracking without PII

**Files:** Create `src/core/observability.ts`, `test/observability.test.ts`. Modify `src/index.ts` (wrap the exported handler with `Sentry.withSentry`).

**Interfaces:** `scrubEvent(event: ErrorEvent): ErrorEvent` (removes `request.data`, `request.cookies`, `request.headers.authorization`, `x-hub-signature-256`, `user`; masks any `\+?\d{8,15}` in `message`/`exception.values[].value` to `[phone]`).

- [ ] **Step 1: Failing tests:** `drops request bodies and auth headers` · `masks phone numbers in messages and exception values` · `keeps the stack frames`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; `withSentry((env) => ({ dsn: env.SENTRY_DSN, release: env.COMMIT_SHA, sendDefaultPii: false, beforeSend: scrubEvent, tracesSampleRate: 0 }), handler)`. With no `SENTRY_DSN` Sentry stays disabled; log one warning per isolate (`sentry: SENTRY_DSN not set`). **Step 4:** run → PASS. **Step 5: Commit** `feat: Sentry with PII scrubbing`.

### Task 1.5: Nightly backup + restore drill

**Files:** Modify `src/core/workspace-do.ts` (`alarm()`, `exportSnapshot()`, `importSnapshot()`, `ensureBackupAlarm()`); create `src/core/backup.ts`, `test/backup.test.ts`, `scripts/backup-pull.sh`, `ops/com.ebda.wa-backup-pull.plist`, `docs/runbooks/backup-restore.md`.

**Interfaces:**
- `BACKUP_TABLES = ['contacts', 'conversations', 'messages', 'message_status_events'] as const`
- `WorkspaceDO.exportSnapshot(date: string): Promise<BackupManifest>` → R2 `backups/<workspaceId>/<date>/<table>.ndjson` + `manifest.json` `{ workspaceId, date, schemaVersion, tables: { [t]: { rows: number; sha256: string } } }`
- `WorkspaceDO.importSnapshot(prefix: string): Promise<BackupManifest>` (only into an empty DO; recomputes counts + hashes and throws on mismatch)
- `ensureBackupAlarm()` called from `ingest()`: sets an alarm for the next 02:00 Africa/Cairo when none is set; `alarm()` exports and re-arms +24 h.

- [ ] **Step 1: Failing tests:** `export writes one file per table and a manifest with counts and hashes` · `import into an empty workspace reproduces counts and hashes` · `import refuses a tampered file` · `import refuses a non-empty workspace` · `ingest arms a daily alarm once` · `alarm exports and re-arms` · `snapshot is consistent while ingest runs` (start export, ingest concurrently, manifest counts == lines per file).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: read every table inside ONE `transactionSync` into strings (a workspace's metadata fits in memory for the spike; record the size limit as a Ruling and the streaming follow-up in Phase 3), then `put` to R2. **Step 4:** run → PASS.
- [ ] **Step 5:** `scripts/backup-pull.sh` mirrors `backups/` from R2 to `~/Backups/ebda-whatsapp/` (wrangler `r2 object get` per manifest listed by a `GET /ops/backups?date=` route guarded by super admin) and `wrangler d1 export ebda-wa-platform --remote --output ~/Backups/ebda-whatsapp/d1-<date>.sql`; keeps 30 days. launchd plist runs it daily at 04:00. Runbook documents restore.
- [ ] **Step 6: Commit** `feat: nightly per-workspace backup to R2 + restore drill + Mac pull`.

### Task 1.6: Erasure (PDPL)

**Files:** Modify `src/core/workspace-do.ts` (`eraseContact(waId)`), `src/index.ts` (`DELETE /api/v1/stores/:storeId/contacts/:waId`, owner or super admin); create `test/erasure.test.ts`.

**Interfaces:** `WorkspaceDO.eraseContact(waId: string): Promise<{ messages: number; statusEvents: number; r2Objects: number }>`

- [ ] **Step 1: Failing tests:** `removes the contact, conversation, messages and status events` · `deletes R2 bodies of that contact` · `leaves other contacts untouched` · `is idempotent` · `route: staff gets 403, owner gets 200`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: collect R2 keys + wamids, delete rows in one `transactionSync`, then delete R2 keys (retry-safe: a repeat finds no rows and deletes nothing). Audit line to logs without the phone (`buyerKey` only). **Step 4:** run → PASS. **Step 5: Commit** `feat: contact erasure across DO and R2`.

### Task 1.7: Account-level setup (documented, partly Ahmad-only)

**Files:** Create `docs/runbooks/cloudflare-account.md`.
- [ ] Logpush Workers trace events → R2 bucket `ebda-wa-logs` with a 30-day lifecycle rule (wrangler/API commands written out; run when Ahmad approves the bucket).
- [ ] Billing notifications for Workers, DO, D1, R2, Queues (dashboard path written out; Ahmad clicks).
- [ ] Sentry project `ebda-whatsapp` in org `whisky11` and `wrangler secret put SENTRY_DSN` (Ahmad: the Sentry CLI here is logged into another org).
- [ ] Commit `docs: Cloudflare account runbook (logs, billing alerts, Sentry)`.

**Phase 1 done =** `npm test` + `npm run typecheck` green on CI (`gh pr checks` green), audit 0, deployed `/health` commit = main tip, backup alarm armed on the live spike workspace once it exists (verified after Task 0.6).
