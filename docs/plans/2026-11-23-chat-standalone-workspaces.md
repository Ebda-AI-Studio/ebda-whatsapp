# Ebda Chat for clients without an Ebda Store (standalone workspaces) - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (or superpowers:executing-plans) to run this plan task by task. Each task is ONE PR. Steps use checkbox (`- [ ]`) syntax.

- **Date:** 2026-11-23 (written ~13:30Z against `ebda-whatsapp` origin/main `ab007f0`, `ebda-store` origin/main `a851640cb`).
- **Approved by:** Ahmad, tonight. **Deadline:** 2026-11-24 00:00 Cairo = **2026-11-23 22:00Z**.
- **Design intent:** `docs/plans/done/2026-10-24-ebda-whatsapp.md:17`: "Ebda AI Studio digital-marketing clients: no store. Campaigns to their own number lists, OTP sending, inbox, AI agent."
- **Register:** no row exists. Task 7 adds `CHAT-SA` to the Ebda program register (`business/ebda/EBDA-PROGRAM-REGISTER.md`, outside this repo) section 2.

## Finish line (Karpathy #5)

- **What must work:** a person with no Ebda Store signs up for Ebda Chat at accounts.ebda.app, verifies the email, redeems an operator invite code, creates a workspace (name, Egypt), opens the inbox, connects a number, buys a Chat package (card or InstaPay), sends a campaign, and (if Task 6 lands) invites a staff member who signs in and works on an assigned seat.
- **Flows exercised:** `accounts.ebda.app/signup?product=chat` -> `/otp/verify` -> `accounts.ebda.app/login?product=chat` -> `chat.ebda.app` boot -> `POST /api/v1/workspaces` -> every `/api/v1/stores/sw_.../*` route the web calls -> package purchase -> operator `GET /operator/workspaces?kind=standalone` + suspend.
- **Must NOT change:** every Store-linked workspace (UUID id) behaves byte-identically: same middleware path, same bridge calls, same D1 reads per request, same Store bridge/ownership model (Ruling CHAT-ENABLE-1), same token claims, same Store signup. The existing test suite passes unmodified except for additive cases.
- **Done =** all PRs merged through `ops/merge-gate.sh`, deployed, `/health` commit == main tip for `ebda-whatsapp` and `ebda-accounts`, and the full flow above driven once on production with a test identity (no real money: the package purchase is checked up to the checkout page, or with the operator test package), plus every negative tenancy test green in CI.

## Goal

Let an Ebda AI Studio client with no Ebda Store use Ebda Chat on its own: own signup, own workspace, own team, own Chat billing, while Store-linked workspaces and the Store's ownership bridge stay exactly as they are.

## Architecture (one paragraph)

A second workspace **kind**, `standalone`, lives next to the existing Store-linked kind. Its id is minted by Chat as `sw_` + 26 lowercase base32 chars, which can never equal a Store id (Store ids are Postgres UUIDs, `packages/database/prisma/schema.prisma:195`), and D1 enforces `kind = 'standalone'` **iff** `id LIKE 'sw_%'`. The routes keep their path (`/api/v1/stores/:storeId/...`); the param is treated as a workspace id. `requireStoreAccess` branches on the id **prefix** before anything else: a UUID-shaped id goes down today's path unchanged (token `stores` claim + live Store bridge + seats; no new read), an `sw_` id goes down a new path where membership comes ONLY from a Chat-side D1 table `workspace_members` keyed by the accounts user id (`sub`), read live on every request; the token's `stores` claim is ignored for `sw_` ids and the D1 table is never consulted for UUID ids. The Store bridge is reached through `bridgeForWorkspace(env, id)`, which is `null` for `sw_` ids, so every store-coupled feature (orders, catalogue, COD, recommendations, Store team) is off by construction. Signup reuses the accounts app's existing store-less `POST /signup` + `/otp/verify` (it already creates an identity with no store, `apps/accounts/src/app.ts:633,1066`); only a Chat-branded signup page and abuse checks are added. Self-serve creation is behind a flag `STANDALONE_WORKSPACES = off | invite | open`, shipped tonight as `invite` (operator-minted single-use codes). Billing is Chat's own (packages, wallet, AI packs, Kashier/InstaPay); `store-included` never applies.

## Verified facts this plan relies on (origin/main, read-only)

| Fact | Evidence |
|---|---|
| Workspace id == store id; only `ensureWorkspace` creates a row, only from `store.linked` after the Store confirms the owner | `src/core/workspace-registry.ts:19-27`, `src/core/store-events.ts:31-48,67-73` |
| `workspaces` table is `(id, name, created_at)` + later columns; latest migration `0041` | `migrations/d1/0001_platform.sql:2`, `migrations/d1/0041_package_names_by_size.sql` |
| Membership = token `stores` claim, then live `bridge.memberRole`, then DO seat for staff | `src/core/identity/middleware.ts:58,137-148` |
| `bridgeFor(env)` is per-DEPLOY, not per workspace; 17 call sites in 14 files | `src/core/store-link.ts:40`; `git grep -n 'bridgeFor(' -- src` |
| Integrator tokens are minted per Store id by accounts | `ebda-store apps/accounts/src/jwt.ts:103` |
| `stores` claim comes from `STORE_DIRECTORY.storesForUser` | `ebda-store apps/accounts/src/app.ts:148-156,183` |
| Accounts `POST /signup` already creates a store-less unverified identity (per-IP 10, per-email 3 limits; generic 202) | `ebda-store apps/accounts/src/app.ts:1066-1085, 633-671` |
| Sign-in page hides the signup link for `product=chat` | `ebda-store apps/accounts/src/sign-in-page.ts:195` |
| No Turnstile anywhere; Store signup abuse controls (honeypot, signed form token, disposable domains, per-domain cap) live in `apps/api` (Express) | `ebda-store apps/api/src/services/signup-abuse.service.ts:1-20`; `git grep -il turnstile -- apps` = empty |
| Accounts RPC already has `inviteUser`, `exportUser`, `eraseUser`, `getAccountsBrief`; Chat binds `ACCOUNTS` but types only `isRevoked` | `ebda-store apps/accounts/src/index.ts:133,242,256,286`; `src/env.ts:87`; `wrangler.jsonc:99` |
| Seats table lives in the workspace DO; `memberLimit` from the package; owner never has a row | `src/core/seats.ts:1-45` |
| Offboarding test walks the D1 schema: a new workspace-keyed table fails CI until decided | `src/core/ops/offboarding.ts:25-36` |
| InstaPay first payment with no plan always goes to a person | `docs/billing.md:149` |
| Operator suspend/unsuspend/offboard are keyed by `:workspaceId`; there is no workspace LIST route | `src/routes/operator.ts:359-487` |
| Web boot picks a store from the token; none -> plain text "not linked to a store" | `web/src/main.tsx:75-79`; `NoWorkspace` at `web/src/App.tsx:32` |

## Rulings (write each into `docs/rulings/CHAT-SA-<n>.md` in Task 7, and the register row)

- **Ruling CHAT-SA-1 - A Chat-only account is created by the accounts app's existing store-less signup (`POST /signup` -> code -> `/otp/verify`) behind a new Chat-branded page `accounts.ebda.app/signup?product=chat`; Chat learns memberships from a Chat-side D1 `workspace_members` table keyed by the accounts user id, NOT from a new token claim.** Evidence: `registerPending` already inserts no store (`app.ts:633-671`); a `workspaces` claim would make accounts (and `STORE_DIRECTORY`) a second membership authority and widen what a 15-minute token can grant after a removal, while a D1 row is read live on every request exactly like the existing kill-switch read (`middleware.ts:126-129`). Cost if wrong: if a later product needs standalone memberships outside Chat, a claim or directory call must be added then (additive, no migration of tokens).
- **Ruling CHAT-SA-2 - Standalone workspaces get their own id space `sw_<26 base32>` with a D1 CHECK `(kind='standalone') = (id LIKE 'sw_%')`; routes keep `/stores/:storeId/...` and treat the param as a workspace id; the middleware branches on the id PREFIX first, so a Store id can never take the standalone path and an `sw_` id can never take the Store path. `bridgeForWorkspace(env,id)` returns null for `sw_`; integrator tokens are refused on `sw_` paths; `ensureWorkspace` and the Store-event consumer refuse any `sw_` id.** Evidence: Store ids are UUIDs (`schema.prisma:195`); adding a `/workspaces/:id` alias would double the scope map (`scopes.ts:176`, every route needs a gate decision) and the web client; the prefix decision needs no extra D1 read for Store traffic. Cost if wrong: the word "stores" stays in standalone URLs (cosmetic; a later rename is a router alias, not a data change).
- **Ruling CHAT-SA-3 - Self-serve creation (`POST /api/v1/workspaces`, name + country EG) is flag-gated `STANDALONE_WORKSPACES=off|invite|open`; tonight production runs `invite` (operator-minted single-use code, hashed, 14-day expiry, consumed in the same D1 batch as the insert); one owned standalone workspace per identity (more only by operator); per-user 3/day and per-IP 10/day creation attempts.** Evidence: there is no Turnstile and the accounts signup has only rate limits (`app.ts:1068-1071`); an open create endpoint would let anyone mint workspaces that hold numbers and send campaigns; the new-workspace campaign cap is already owner-scoped (`campaigns/new-cap.ts:17-19`). Cost if wrong: genuine clients wait for an operator code until the flag flips to `open` (one env change).
- **Ruling CHAT-SA-4 - Standalone teams live in Chat: owner + staff in `workspace_members`; the owner invites by email through a new accounts RPC `inviteChatMember` (creates an unverified identity via the existing `inviteFor`, or resolves an existing one) and the answer to the owner is identical either way ("invite sent"); seats reuse the DO `seats` table and `memberLimit`; removal flips the row to `removed` and drops the seat in the same request.** Evidence: Store team semantics are owner/staff + seat by assignment (`seats.ts:1-6`, `capabilities/team.invite-roles.capability.json:34`); `inviteUser` already exists (`index.ts:286`). Cost if wrong: if this task slips, standalone workspaces launch owner-only (the safe cut, Task 6).
- **Ruling CHAT-SA-5 - For standalone workspaces the web hides every store-coupled surface (orders pane, catalogue section, COD settings/outcome, product-recommendations switch, store-link help, Store picker wording, Store-managed team text, `store-included` package card, NoWorkspace's Store link) driven by `/me.kind === 'standalone'` and `capabilities.store === false`; Smart Layer tools declare `needsStore` and store tools are not registered for standalone; copy says "workspace"/"مساحة العمل", never "store"/"متجر".** Evidence: order pane, catalogue, COD are already null-safe without a bridge; recommendations, store-link docs, Team/Seats and NoWorkspace assume a store (`web/src/components/NoWorkspace.tsx`, `TeamScreen.tsx`, `StoreMenu.tsx`). Cost if wrong: a hidden feature a standalone client could have used is missing until shown (no data risk).
- **Ruling CHAT-SA-6 - Standalone billing = Chat purchases only (packages via Kashier card or InstaPay, EGP wallet, AI packs); no `store-included`, no trial (CHAT-ENABLE-1: enabling starts no trial clock); the first InstaPay payment of a standalone workspace always goes to a person (the existing "no plan" rule), card payments unchanged.** Evidence: `docs/billing.md:51,85,149,166`; `store-plan.ts` only writes from Store events, which a standalone workspace never receives. Cost if wrong: first InstaPay payments from standalone clients take up to one business day to confirm.
- **Ruling CHAT-SA-7 - Operators see standalone workspaces through a new `GET /operator/workspaces?kind=&cursor=` list (cursor-paginated, explicit columns) and mint/revoke invite codes at `/operator/standalone-invites`; suspend/unsuspend/offboard/view-as reuse the existing `:workspaceId` routes unchanged.** Evidence: `operator.ts:359-487` are id-keyed; no list route exists. Cost if wrong: none beyond one extra route if the operator console wants a different filter.
- **Ruling CHAT-SA-8 - Security: creation needs a verified person token (no integrator, session revocation checked as a write), audited (`workspace.created`, `member.added|removed`, `invite.minted|consumed`); tenancy is enforced by the prefix branch and proven by a negative test matrix; workspace erasure = the existing offboarding flow with Store steps skipped; Chat-only identity export/erase = accounts `exportUser`/`eraseUser`, run by an operator runbook tonight (a self-serve "delete my account" in Chat is NOT shipped tonight), and erasing an identity that still owns a live standalone workspace is refused until the workspace is offboarded.** Evidence: `middleware.ts:107-114` (session check on writes), `index.ts:242-259` (RPCs exist), `offboarding.ts:25`. Cost if wrong: a Chat-only person asking for erasure waits for support (PDPL allows 30 days) until the self-serve path ships.
- **Ruling CHAT-SA-9 - No public "Ebda Chat without a store" entry on ebda.app tonight; the only entry is the accounts sign-in page for `product=chat` ("Have an invite? Create your account") while the flag is `invite`; the ebda.app CTA ships when the flag flips to `open`, in Egyptian-Arabic full sentences, no orange.** Evidence: public copy says Chat is live, but an open CTA to an invite-gated flow is a dead end for strangers. Cost if wrong: a few days of later discovery for organic Chat-only leads.

## Out of scope tonight (safe cut, stated up front)

- Flag `open` (public self-serve) and the ebda.app marketing CTA (CHAT-SA-9).
- Self-serve account deletion/export inside Chat for Chat-only identities (runbook, CHAT-SA-8).
- Integrator API tokens for standalone workspaces (accounts clients are Store-scoped; refused on `sw_`).
- Countries other than Egypt (EGP wallet + InstaPay only).
- Team (Task 6) is the first thing cut if it is not merged by **20:30Z**: standalone launches owner-only, Team screen hidden.

## PR breakdown, lanes and merge order

| PR | Repo | Title | Depends on | Lane | Labels | Est. |
|---|---|---|---|---|---|---|
| 1 | ebda-whatsapp | Data model: workspace kind, `sw_` ids, members + invites tables | - | A | `risky` (tenancy) | 2 h |
| 2 | ebda-whatsapp | Auth: standalone branch in `requireStoreAccess`, `bridgeForWorkspace`, `/me.kind` | 1 | A | `risky` (auth), `deploy-change` | 3-4 h |
| 3 | ebda-whatsapp | Creation API, invite codes, operator list | 1 | B | `risky` (auth/abuse) | 3 h |
| 4 | ebda-store (accounts) | Chat signup page + abuse checks | - | C | `risky` (auth), `deploy-change` | 2-3 h |
| 5 | ebda-whatsapp (web) | Boot, Create workspace, hide store-coupled UI, copy | contract of 2+3 (build now, merge after) | D | - | 3-4 h |
| 6a | ebda-store (accounts) | RPC `inviteChatMember` | - | C | `risky` (auth) | 1.5 h |
| 6 | ebda-whatsapp | Standalone team: members, invites, seats | 2, 6a | A | `risky` (auth) | 3 h |
| 7 | ebda-whatsapp | Billing guards, Smart Layer gating, docs, rulings, register | 2 | B | `risky` (billing) | 2-3 h |

- **Start immediately (parallel):** PR-1 (lane A), PR-4 + PR-6a (lane C, same repo/app, one builder sequentially or two builders on separate files), PR-5 (lane D, against the API contract in this plan using the fake api source).
- **After PR-1 merges (~15:30Z):** PR-2 (lane A) and PR-3 (lane B) in parallel. Both touch `src/index.ts`: PR-3 mounts its routers in a separate block below `app.route('/api/v1', api)`; whoever merges second rebases.
- **After PR-2 merges (~19:00Z):** PR-7 (lane B), PR-6 (lane A, needs 6a deployed).
- **Merge order:** 1 -> 4 -> 6a -> 2 -> 3 -> 7 -> 5 -> 6. PR-4 and PR-6a may merge any time (a store-less identity is already creatable through the existing `POST /signup`; the RPC has no caller until PR-6). Production keeps `STANDALONE_WORKSPACES=off` until PR-5 is deployed, then `invite`.
- **Max concurrency:** 4 builders (lanes A-D), Sonnet; one Opus whole-branch review for PR-2 and PR-3 together (auth), per LEAN mode.

## API contract (what PR-5 builds against)

- `GET /api/v1/workspaces/mine` (person token) -> `{ items: [{ id, name, role: 'owner'|'staff', kind: 'standalone' }], canCreate: boolean, needsInvite: boolean }` (max 50).
- `POST /api/v1/workspaces` `{ name: string(1..100), country: 'EG', inviteCode?: string }` -> `201 { id, name }` | `409 { error:'already_owns_workspace', id }` | `403 { error:'forbidden', message:'standalone_off'|'invite_required'|'invite_invalid' }` | `429`.
- `GET /api/v1/stores/:id/me` adds `kind: 'store'|'standalone'` and `capabilities.store: boolean`; `stores` (picker) lists Store workspaces from the token plus standalone memberships from D1, each with `kind`.
- Team (PR-6): `GET /api/v1/stores/:id/members` (standalone: from D1), `POST /api/v1/stores/:id/members/invite { email, firstName, language }` -> `202 { status:'invite_sent' }` | `409 seat_limit`, `DELETE /api/v1/stores/:id/members/:userId`.

---

## Task 1 (PR-1): Data model - workspace kind, `sw_` ids, members and invites tables

**Repo:** ebda-whatsapp. **Branch:** `feat/chat-sa-1-data-model`.

**Files:**
- Create: `migrations/d1/0042_standalone_workspaces.sql`
- Create: `src/core/workspace-kind.ts`
- Modify: `src/core/workspace-registry.ts` (refuse `sw_` in `ensureWorkspace`; add `createStandaloneWorkspace`)
- Modify: `src/core/store-events.ts` (acknowledge + log any event whose `storeId` is not UUID-shaped, before the `workspaces` lookup)
- Modify: `src/core/ops/offboarding.ts` (decisions for `workspace_members` -> delete with workspace, `standalone_invites` -> keep `used_workspace_id` nulled, audit-only)
- Test: `test/workspace-kind.test.ts`, `test/workspace-registry.test.ts` (extend), `test/store-events.test.ts` (extend), offboarding schema-walk test (passes)

**Migration content (spec, builder writes SQL):**
- `ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'store'` with CHECK `kind IN ('store','standalone')`. D1/SQLite cannot add a CHECK referencing two columns via ALTER, so enforce `(kind='standalone') = (id LIKE 'sw_%')` with `BEFORE INSERT` and `BEFORE UPDATE OF id, kind` triggers that `RAISE(ABORT, 'workspace_kind_id_mismatch')`.
- `ALTER TABLE workspaces ADD COLUMN country TEXT NOT NULL DEFAULT 'EG'`.
- `workspace_members (workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','staff')), status TEXT NOT NULL CHECK (status IN ('active','removed')), added_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, user_id))`; index `(user_id, status)`; a trigger refusing inserts whose `workspace_id` does not start with `sw_`.
- `standalone_invites (code_hash TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by TEXT, used_workspace_id TEXT, revoked_at INTEGER, note TEXT)`; index `(created_at)`.
- `workspace_creations (user_id TEXT NOT NULL, ip_hash TEXT NOT NULL, at INTEGER NOT NULL)` for the creation rate limit; index `(user_id, at)`, `(ip_hash, at)`; retention: rows older than 2 days pruned by the existing daily scheduler.

**`workspace-kind.ts`:** `STANDALONE_PREFIX = 'sw_'`; `isStandaloneId(id)` (exact regex `^sw_[a-z2-7]{26}$`); `isStoreId(id)` (UUID regex already used in `routes/members.ts:16`, moved here and re-exported); `mintStandaloneId()` from `crypto.getRandomValues` (130 bits).

**`createStandaloneWorkspace(env, { ownerUserId, name, country, inviteCodeHash|null, now })`:** ONE D1 batch: (a) when an invite hash is given, `UPDATE standalone_invites SET used_at, used_by WHERE code_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`; (b) `INSERT INTO workspaces (id,name,created_at,kind,country) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND m.role='owner' AND m.status='active' AND w.kind='standalone') AND (? IS NULL OR EXISTS (SELECT 1 FROM standalone_invites WHERE code_hash=? AND used_by=? AND used_at=?))`; (c) owner row in `workspace_members` conditional on (b) having inserted (`WHERE EXISTS (SELECT 1 FROM workspaces WHERE id=?)`); (d) `workspace_owners` row (campaign cap owner scope, `new-cap.ts:11`); (e) set `used_workspace_id`. Returns `created | already_owns | invite_invalid`. Logs `audit: workspace_created` (ids only).

- [ ] Write failing tests:
  - mint: 1000 ids all match `^sw_[a-z2-7]{26}$`, none passes `isStoreId`.
  - D1 trigger: inserting `kind='standalone'` with a UUID id aborts; inserting `kind='store'` with `sw_...` aborts; `workspace_members` insert for a UUID workspace aborts.
  - `ensureWorkspace({storeId:'sw_...'})` throws and writes nothing.
  - Store event `store.linked` with `storeId: 'sw_...'` is acked, creates no row, logs `store_event_non_store_id`.
  - `createStandaloneWorkspace`: created once; second call by same user -> `already_owns` and still exactly one row; invite used twice -> second `invite_invalid` with no workspace row; expired/revoked invite -> `invite_invalid`; two concurrent calls (Promise.all) -> exactly one workspace.
  - offboarding schema walk passes with the two new decisions.
- [ ] Implement until green; run touched tests only (`npx vitest run test/workspace-kind.test.ts test/workspace-registry.test.ts test/store-events.test.ts test/offboarding.test.ts`), then typecheck.
- [ ] Apply migration to the local D1 (`wrangler d1 migrations apply --local`) and check the triggers with a SELECT.

**Acceptance:** migration applies cleanly to a local D1 built from all migrations 0001-0042 (this repo has no preview/staging environment: production only, behind switches); all existing tests pass unchanged; no runtime path uses the new tables yet except `createStandaloneWorkspace` (no caller until PR-3).

---

## Task 2 (PR-2): Auth - standalone branch, `bridgeForWorkspace`, `/me.kind`

**Repo:** ebda-whatsapp. **Branch:** `feat/chat-sa-2-auth`. **Depends:** PR-1 merged. **Review:** Opus whole-branch (auth).

**Files:**
- Modify: `src/core/identity/middleware.ts` (`requireStoreAccess`)
- Modify: `src/core/store-link.ts` (add `bridgeForWorkspace(env, workspaceId)`)
- Modify (replace `bridgeFor(` with `bridgeForWorkspace(`, passing the workspace id already in scope): `src/core/ai/agent.ts`, `src/core/ai/knowledge.ts`, `src/core/ordering/bot.ts`, `src/core/store-link/catalog-provision.ts`, `src/core/store-link/catalog.ts`, `src/core/store-link/events.ts`, `src/core/store-link/orders.ts`, `src/core/store-link/proactive-recs.ts`, `src/core/workspace-do.ts`, `src/routes/orders.ts`, `src/routes/members.ts` (standalone returns 404 `store_link_off` until PR-6), `src/index.ts` (`/me`)
- Leave on plain `bridgeFor`: `src/core/store-events.ts` (Store events are UUID-only after PR-1)
- Create: `test/standalone-tenancy.test.ts`, `test/bridge-for-workspace-guard.test.ts`
- Modify: `src/core/api/contract.ts` (`/me` response type: `kind`, `capabilities.store`, picker items with `kind`)

**Middleware spec (`requireStoreAccess`), inserted right after the token verifies and `storeId` is read:**
1. If `storeId` is neither `isStoreId` nor `isStandaloneId` -> `404 not_found` (no audit write, no DO).
2. If `isStoreId(storeId)`: **today's code path unchanged** (no new read).
3. If `isStandaloneId(storeId)`:
   - `principal.integration` -> `403 forbidden` (CHAT-SA-2).
   - Ignore `principal.stores` entirely. Read `SELECT w.kind, w.suspended_at, w.integrations_revoked_at, m.role, m.status FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?` (one read; D1 error -> `503 membership_unavailable`, fail closed; no row -> `404`; `kind !== 'standalone'` -> `500` + alert, impossible by trigger).
   - Membership = `m.status === 'active'` ? `{ role: m.role }` : none. Non-member non-super-admin -> refuse 403 (audited as today). Super admin non-member -> the same view-as / operator-route rules as today (reuse the existing code below by setting `membership`).
   - Session check, suspension check, rate limit: same code as today (reuse the row already read for suspension instead of the second SELECT).
   - Staff -> DO `seatOf(userId)` must be `seated` (same as today). No bridge call.
4. `c.set('storeRole', ...)` exactly as today.

**`bridgeForWorkspace(env, id)`** = `isStandaloneId(id) ? null : bridgeFor(env)`. Pure; no I/O.

**`/me`:** `kind` from the prefix; `capabilities.store = bridgeForWorkspace(...) !== null`; `codOutcome` uses `bridgeForWorkspace`; `assistant` unchanged; the picker merges token Store memberships (existing query) with `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ... WHERE m.user_id=? AND m.status='active' LIMIT 50`.

- [ ] Write failing tests first (`test/standalone-tenancy.test.ts`), each a separate `it`:
  - member owner of `sw_A` reads/writes `sw_A` -> 200.
  - same user, `sw_B` (not a member) -> 403; super admin without view-as -> 403 `view_as_required`; super admin write -> 403 `operator_route_required`.
  - token whose `stores` claim lists `sw_B` as owner (forged by a test verifier) but no D1 row -> 403 (claim ignored).
  - D1 member of `sw_A` whose token claim lists a Store UUID `S1` they are NOT a member of in the Store fake -> `S1` 403 (D1 never consulted for UUID ids; assert zero `workspace_members` reads via a spy).
  - removed member (`status='removed'`) -> 403 on the next request (never-stale).
  - staff without seat -> 403 `no_seat`; with seat -> 200.
  - integrator token on `sw_A` -> 403.
  - malformed id (`sw_SHORT`, `../`, `%73w_...`) -> 404, no DO touched.
  - suspended `sw_A`: write 403 `workspace_suspended`, wallet write allowed (same `allowedWhileSuspended`).
  - D1 throws -> 503, never 200.
  - every route in `apiRoutes` with an `sw_` id and no membership -> 403/404 (walk the router like the scopes test does).
- [ ] `test/bridge-for-workspace-guard.test.ts`: fails if `bridgeFor(` appears in `src/` outside `store-link.ts` and `store-events.ts` (CI guard for the defect class).
- [ ] Unit: each converted call site returns its "no Store" branch for an `sw_` id (orders route 404 `store_link_off`, catalogue status "not linked", proactive recs off, agent knowledge without catalogue, ordering bot without catalogue/COD).
- [ ] Run the full existing identity suite (`test/identity*.test.ts`, members, orders) unchanged -> green. Then full suite once at PR end.

**Acceptance:** the UUID path has no new D1 read (spy test); all negative tests green; Opus review signs off; after deploy, `curl /api/v1/stores/<real store>/me` with a real merchant token is unchanged and `/api/v1/stores/sw_aaaaaaaaaaaaaaaaaaaaaaaaaa/me` returns 404.

---

## Task 3 (PR-3): Creation API, invite codes, operator list

**Repo:** ebda-whatsapp. **Branch:** `feat/chat-sa-3-create`. **Depends:** PR-1. **Parallel with:** PR-2.

**Files:**
- Create: `src/routes/workspaces.ts` (`GET /workspaces/mine`, `POST /workspaces`)
- Create: `src/core/identity/person.ts` (`requirePerson`: verified token, `!principal.integration`, `writeSessionState` on POST; reuses `getVerifier`)
- Modify: `src/index.ts` (mount `api.use('/workspaces/*', requirePerson(getVerifier))` + `api.use('/workspaces', ...)` and `api.route('/', workspacesRoutes)`; keep `auditWrites` after it)
- Modify: `src/core/identity/scopes.ts` (gate entries for the two routes: `person_only`)
- Modify: `src/routes/operator.ts` (`GET /workspaces?kind=&cursor=`, `POST /standalone-invites { note, days<=30 }` -> returns the plain code ONCE, `GET /standalone-invites`, `POST /standalone-invites/:hash/revoke`)
- Modify: `src/env.ts` + `wrangler.jsonc` vars (`STANDALONE_WORKSPACES`, default `off`; production stays `off` until PR-5 is live)
- Modify: `.env.example` / `docs/` env table if present
- Test: `test/workspaces-routes.test.ts`, `test/operator-workspaces.test.ts`

**Rules:**
- Flag `off` -> `403 standalone_off`; `invite` -> `inviteCode` required (`403 invite_required`); invalid/used/expired -> `403 invite_invalid` (one message for all three); `open` -> no code.
- Code format: 12 chars Crockford base32, shown grouped `XXXX-XXXX-XXXX`; stored as HMAC-SHA256 with an existing server secret (reuse the audit/erasure key helper, `subjectHash`-style) - never plain.
- Rate limit: insert into `workspace_creations` first; refuse when the user has >= 3 or the IP hash >= 10 rows in 24 h (`429`, `retry-after`). Counted on every attempt, including refused ones.
- Body validated with Zod; name trimmed 1..100, control chars stripped; `country` literal `'EG'`.
- `recordAudit` rows: `workspace.created`, `invite.minted`, `invite.revoked`, `invite.consumed` (ids/hashes only).
- `GET /operator/workspaces`: explicit columns (`id, name, kind, country, created_at, suspended_at`, owner user id), `ORDER BY created_at DESC, id`, cursor = base64 of `(created_at,id)`, limit 50.

- [ ] Failing tests: flag matrix (off/invite/open); invite reuse; one-owned limit returns 409 with the existing id; rate limit 4th attempt 429; integrator token -> 403; revoked session -> 403; unverified/expired token -> 401; name with 101 chars -> 400; operator routes 403 for non-super-admin; operator list paginates stably across 120 rows; minted code plain text never appears in D1 or logs (scan the log spy).
- [ ] Implement; touched tests; typecheck.

**Acceptance:** locally (`wrangler dev`, flag `invite`), then on production after deploy with the flag still `off` (expect `403 standalone_off`), and after PR-5 with `invite`: mint a code as operator, create a workspace with a test identity, `/workspaces/mine` lists it, a second create returns 409, the operator list shows it with `kind=standalone`.

---

## Task 4 (PR-4): Chat signup page on accounts + abuse checks

**Repo:** ebda-store, app `apps/accounts`. **Branch:** `feat/chat-sa-4-chat-signup`. **Parallel:** from now.

**Files:**
- Create: `apps/accounts/src/signup-page.ts` (server-rendered page, same shell/CSS/CSP as `sign-in-page.ts`; steps: details form -> "check your email" code form posting to `/otp/verify` -> success -> redirect to `/login?product=chat&return=<chat>`)
- Modify: `apps/accounts/src/app.ts` (`GET /signup?product=chat` serves the page; `POST /signup` gains: honeypot field `website` -> same 202 and nothing created; disposable-domain refusal via `isDisposableEmail` from `@ebda/shared` -> same generic 202 and nothing created; keep existing per-IP 10 / per-email 3 limits)
- Modify: `apps/accounts/src/sign-in-page.ts:195` (for `product === 'chat'` show "معاك دعوة؟ اعمل حسابك" linking to `/signup?product=chat&return=...`, instead of nothing; other products unchanged)
- Modify: accounts copy file (ar default, en) - Egyptian-Arabic full sentences
- Test: `apps/accounts/test/signup-page.test.ts`, extend `apps/accounts/test/app.test.ts` (or the existing signup test file)

**Rules:** the `return` parameter is accepted only if it is an https URL on the allowed Chat origin list (reuse `signInEntryUrl` bounds, `app.ts:678`); no response reveals whether the email exists; the page sets the same security headers as the sign-in page; the identity created keeps `role='store_admin'` as today (Store admin will show its normal "create your store" onboarding if this person ever opens it - accepted).

- [ ] Failing tests: `GET /signup?product=chat` 200 with CSP header and no inline script without nonce; honeypot filled -> 202, no `users` row; disposable domain -> 202, no row; normal -> 202, unverified row with no store link; `return=https://evil.example` is dropped; sign-in page for `product=chat` contains the signup link, for `product=store` still links to the Store signup (unchanged).
- [ ] Implement; run accounts tests + typecheck for the accounts app only.

**Acceptance:** on production accounts after deploy (no preview env): sign up with a fresh mailbox, receive the code, verify, sign in with `product=chat`, land on Chat with a token whose `stores` is `[]`.

---

## Task 5 (PR-5): Web - boot, Create workspace, hide store-coupled UI, copy

**Repo:** ebda-whatsapp (`web/`). **Branch:** `feat/chat-sa-5-web`. **Builds now against the contract; merges after PR-2 and PR-3.**

**Files:**
- Modify: `web/src/main.tsx` (after the token: if `?store=` names an `sw_` id or the token has no stores, call `GET /api/v1/workspaces/mine`; pick from the merged list; none -> render `CreateWorkspace`; keep the view-as path unchanged)
- Create: `web/src/components/CreateWorkspace.tsx` (name, country fixed "مصر", invite code field when `needsInvite`; errors mapped from the contract; on 201/409 navigate to `?store=<id>`)
- Modify: `web/src/App.tsx` / `NoWorkspace.tsx` (standalone users never see the "connect from Store settings" link; Store merchants unchanged)
- Modify: `web/src/components/StoreMenu.tsx` (picker shows both kinds; label "مساحات العمل" when any standalone item; Store items unchanged)
- Modify (hide when `kind==='standalone'` / `!capabilities.store`): order pane, catalogue section, COD settings + outcome, product-recommendations switch, store-link help links, `store-included` package card, Store-managed team text in `TeamScreen.tsx` (shows "Team coming soon" until PR-6, or the PR-6 UI)
- Modify: `web/src/i18n.ts` (standalone variants of every string that says store/متجر on a surface a standalone user sees; Egyptian-Arabic full sentences)
- Modify: `web/src/api*` source + fake source (new endpoints; fake source gets a standalone fixture)
- Test: `web/src/CreateWorkspace.test.tsx`, `web/src/StandaloneShell.test.tsx` (renders with standalone fixture: none of the hidden surfaces present; no visible string matches `/store|متجر/i`), extend `ShellStore.test.tsx` (Store fixture unchanged)

- [ ] Failing tests above; then implement; `npm run -w web test -- <files>` + web typecheck + build.
- [ ] Drive it locally against `wrangler dev`, then on production once the flag is `invite` (Chrome, console + network armed): signup -> create -> inbox; Arabic locale first, then English; phone width 375 px.

**Acceptance:** Store fixture snapshots unchanged; standalone fixture shows inbox, contacts, campaigns, templates, numbers, wallet/packages, AI agent, and nothing store-coupled; live production walk (flag `invite`, test mailbox) recorded in the PR (no screenshots to Ahmad).

---

## Task 6a (PR-6a): Accounts RPC `inviteChatMember`

**Repo:** ebda-store (`apps/accounts`). **Branch:** `feat/chat-sa-6a-invite-rpc`. **Parallel:** from now (same builder as PR-4 after it, or a second builder; different files).

**Files:** Modify `apps/accounts/src/index.ts` (new method), `apps/accounts/src/data.ts` if a helper is needed; Test `apps/accounts/test/invite-chat-member.test.ts`.

**Spec:** `inviteChatMember({ email, firstName, language, workspaceName })` -> `{ userId }`. Zod-validated. Existing ACTIVE identity -> returns its id and mails "you were added to <workspaceName> on Ebda Chat, sign in at <chat url>" (rate-limited per email 5/day, silent beyond); no identity -> `inviteFor` with a fresh UUID and `role:'staff'`, mails the set-password code; inactive/erased identity -> throws `INVITE_REFUSED` (Chat shows the generic message). Never returns whether the identity pre-existed.

- [ ] Failing tests for the three branches + rate limit + return shape identical across branches; implement; accounts tests + typecheck.

**Acceptance:** unit tests green; after deploy, exercised for real only through PR-6 (no caller before that).

---

## Task 6 (PR-6): Standalone team - members, invites, seats

**Repo:** ebda-whatsapp. **Branch:** `feat/chat-sa-6-team`. **Depends:** PR-2 merged, PR-6a deployed. **Cut-off:** not merged by 20:30Z -> ship owner-only (PR-5 already hides Team for standalone; this PR flips it on).

**Files:**
- Modify: `src/routes/members.ts` (branch on `isStandaloneId`: list from `workspace_members` + `ACCOUNTS.getAccountsBrief` for names/emails; `POST /members/invite` owner-only; `DELETE /members/:userId` owner-only, cannot remove the owner; seat assign/remove reuse the DO `assignSeat`/`removeSeat`)
- Create: `src/core/standalone-members.ts` (brand-neutral: `src/core/**` never names Ebda; mail copy lives in accounts) (add/remove member rows; remove = `status='removed'` + DO `removeSeat` in the same request; invite = check seat room first (`409 seat_limit`), call `ACCOUNTS.inviteChatMember`, insert `active` staff row, assign seat)
- Modify: `src/env.ts` (type `ACCOUNTS` with `inviteChatMember`, `getAccountsBrief`)
- Modify: `web/src/components/TeamScreen.tsx` (standalone: invite form + remove; Store: unchanged)
- Modify: `capabilities/team.invite-roles.capability.json` (document standalone semantics)
- Test: `test/standalone-members.test.ts`, extend `web/src/TeamScreen.test.tsx`

- [ ] Failing tests: staff cannot invite/remove (403); owner cannot remove self; invite when seats full -> 409 and no accounts call; removed staff next request 403 (via PR-2 middleware); invite response identical for new and existing email; accounts RPC failure -> 503, no member row; audit rows `member.added|removed`.
- [ ] Implement; touched tests; typecheck.

**Acceptance:** production, test mailboxes: owner with a 3-member package (operator test package) invites a second test mailbox, it signs in, sees the workspace in the picker, works; owner removes it; its next request is 403.

---

## Task 7 (PR-7): Billing guards, Smart Layer gating, docs, rulings, register

**Repo:** ebda-whatsapp. **Branch:** `feat/chat-sa-7-billing-docs`. **Depends:** PR-2.

**Files:**
- Modify: `src/core/billing/subscriptions.ts` (the `store-included` fallback at ~:191 skips `sw_` ids explicitly - belt and braces)
- Modify: `src/core/billing/instapay-auto.ts` (the caller only; `foundation/` is vendored and never edited here, FDN-VENDOR-1) (standalone first payment -> person review; verify it already is via "no plan", add the test either way)
- Modify: `src/core/smart-layer/registry.ts` + tools in `src/core/smart-layer/tools/*.ts` (each tool declares `needsStore`; registry omits them when `capabilities.store === false`); `src/core/smart-layer/coverage.ts` test asserts every tool declares it
- Create: `docs/rulings/CHAT-SA-1.md` .. `CHAT-SA-9.md` (text from this plan)
- Modify docs (doc parity): `docs/billing.md` (standalone: no store-included, InstaPay first payment), `docs/store-link.md` (standalone = no bridge), `docs/data-protection.md` + `docs/erasure-and-audit.md` (Chat-only identity runbook, `workspace_members`), `docs/offboarding.md` (new tables), `docs/support.md` (minting invite codes), new runbook `docs/runbooks/standalone-workspaces.md` (flag, invites, erasure of a Chat-only identity, suspend)
- Modify: the Ebda program register (`business/ebda/EBDA-PROGRAM-REGISTER.md`, outside this repo) section 2 (row `CHAT-SA`, recount summary) - controller does this at merge time if the builder cannot write outside the repo
- Test: `test/standalone-billing.test.ts` (package purchase by card creates `workspace_subscriptions` source `purchase` for `sw_`; wallet top-up works; a Store plan event can never write to `sw_`; no `store-included` fallback after a bought package ends), Smart Layer coverage test

- [ ] Failing tests; implement; touched tests; full suite once at PR end.

**Acceptance:** billing tests green; docs updated in the same PR; rulings files present; register row written.

---

## Deploy and production verification (controller, after each merge; Rule F)

1. `ebda-whatsapp`: `curl -s https://chat.ebda.app/health` -> `commit` == `git rev-parse origin/main`. Apply D1 migration 0042 to prod BEFORE the Worker that reads it (the deploy workflow order; confirm the migration step ran in the job log). Read-only prod check: `SELECT kind, count(*) FROM workspaces GROUP BY kind` -> all `store`.
2. `ebda-accounts`: health commit check; `curl -s 'https://accounts.ebda.app/login?product=chat' | grep -c 'signup?product=chat'` == 1; `product=store` page unchanged.
3. Set `STANDALONE_WORKSPACES=invite` only after PR-5 is live.
4. Live walk with a test mailbox: signup -> verify -> login product=chat -> Create workspace with an operator code -> inbox loads -> numbers page -> packages page up to checkout (no real payment) -> operator list shows it -> operator suspend -> write refused -> unsuspend.
5. Regression on a real Store merchant (Amelia test store): `/me` unchanged, orders pane + catalogue present, team from Store.
6. Report both halves: what was verified, and what could not be (e.g. a real InstaPay payment, Meta number connection for a brand-new WABA).

## Risks

- **Riskiest: PR-2 middleware.** A slip either opens cross-tenant access or locks every Store merchant out. Mitigations: prefix branch so the Store path is untouched code; spy test proving no new read on UUID ids; negative matrix; router walk; Opus review; deploy in a quiet hour and run step 5 immediately.
- **Two migrations racing:** only PR-1 adds a migration (`0042`). Any other PR that needs one takes `0043+` and rebases.
- **`src/index.ts` conflicts** between PR-2 and PR-3: keep PR-3's mount in its own block.
- **Accounts copy/CSP regressions** on the shared sign-in page: PR-4 tests assert the Store variant is unchanged.
- **Time:** if PR-2 is not merged by 19:30Z, stop PR-5/6/7 merges, keep the flag `off`, and ship nothing user-visible tonight (the merged pieces are inert without the flag).
