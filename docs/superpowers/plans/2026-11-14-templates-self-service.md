# Ebda Chat Templates Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merchant creates, submits, edits, deletes and tracks WhatsApp message templates on their OWN WhatsApp Business account from an Arabic-first Templates screen, with starter templates and a Meta sync installed automatically when a number connects, through one service API that the Ebda AI Smart Layer template-writer will call unchanged.

**Architecture:** Pure, shared modules (Meta rule checker, draft-to-Meta-components builder) used by the screen for live feedback and by the server as the gate. A service layer (`templates-service.ts`) owns create/edit/delete/check/sync/install-defaults against Meta; Hono routes and the connect hook are thin callers. The per-workspace Durable Object `templates` table gains the Meta template id, a merchant label and an edit log (additive migration). The existing webhook (`message_template_status_update`) and a stale-PENDING sweep keep status current.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite) + D1, Hono, Zod, React (web/), vitest (`@cloudflare/vitest-pool-workers` for `test/`, jsdom for `web/src/*.test.tsx`).

**Spec:** `ebda-foundation/docs/superpowers/specs/2026-11-14-self-service-and-ebda-assistant-design.md` sections 7.2, 7.3, 6.7, 6.8, 6.8b, 4 and Appendix A items A1-A4 and A18 (+ help doc 04 fix). Sub-plan 2 of 4. Reference audits (Ahmad's local business folder): `business/ebda/audits/2026-11-14-chat-capability-catalogue.md` (templates area) and the "Chat templates map" in `2026-11-14-self-service-and-ai-assistant-audit.md`.

## Global Constraints

- Cloudflare-only runtime; Arabic-first RTL UI, Egyptian Arabic copy in full sentences, English second; Ebda brand: no orange, night + Ebda gold; product name always "Ebda Chat", never bare "Ebda".
- Action policy (spec section 4): `free` = list, check, sync; `confirm` = submit to Meta (create), edit (resubmits to Meta), delete, install-defaults (irreversible undo class: a submission cannot be recalled). The policy lives next to the capability definition (registry entry), not in a prompt.
- One API for the screen and the Smart Layer (spec 6.7): no screen-only logic on the server, no assistant-only route.
- Acting as the merchant: every call goes through the existing route authorization (`managesStore` = owner or super_admin for writes; staff may read). No new token type.
- Every cache or stored status is Meta's latest answer; a template is sendable only when `status = 'APPROVED'` (existing rule in `workspace-do.ts` send path) and stays so.
- DO migrations are additive only (`test/migrations-additive.test.ts`); contract changes are additive (optional fields).
- Never log template bodies, example values or phone numbers (log name, language, category, status only).
- Tests exercise the real DO/D1 path (`test/helpers/*`), Graph is stubbed with `graphStub`; each task runs only its touched tests, full `npm run typecheck` + suite at the end (host-lock for the heavy run).
- Commits: lower-case conventional subject, "pr 123" never "#123", end with the `Co-Authored-By` and `Claude-Session` trailers from the session reminder. `git add` specific paths only.
- Meta limits are copied verbatim into `src/core/meta/template-rules.ts` with the source URL; anything Meta's docs did not state is a WARNING (never a blocker) until measured against a real Meta response in Task 14.

### Meta limits this plan builds on (verified 2026-11-14 against Meta's official docs)

Sources: components https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md · management https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-management.md · review https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review.md · categorization https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization.md · overview https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates

| Item | Limit / rule |
|---|---|
| Name | lowercase alphanumeric + underscore, max 512; reusable across languages, each language counts toward the template limit |
| Categories | `AUTHENTICATION`, `MARKETING`, `UTILITY`; mixed content (e.g. order update + promo) is classified MARKETING; utility must be non-promotional; 1-day notice before UTILITY becomes MARKETING (webhook `template_category_update`); `allow_category_change` deprecated, recategorisation is the default |
| Body | required, one, max 1024 chars; positional `{{1}}`.. sequential from 1; an example value per variable |
| Header | one; text max 60 chars, max 1 variable (example required); IMAGE/VIDEO/GIF/DOCUMENT need a Resumable Upload handle (out of v1 scope, see Task 1 ruling) |
| Footer | optional, one, text only, max 60 chars |
| Buttons | max 10 total; QUICK_REPLY max 10, text max 25; URL max 2, text max 25, url max 2000, 1 variable appended at the end (example required); PHONE_NUMBER max 1, text max 25, number max 20; copy code max 1, example max 20; quick-replies and other button types must form TWO contiguous groups |
| Authentication | OTP button; no URLs, media or emojis; parameters max 15 chars |
| Review | up to 24 h; rejection themes: parameter formatting (missing/mismatched braces, `#` `$` `%`, non-sequential, too many parameters for the length, starts or ends with a parameter), policy (commerce, sensitive identifiers, abusive/scam), length/emoji, duplicate body+footer (not for AUTHENTICATION) |
| Edit | `POST /{template-id}`; only APPROVED, REJECTED, PAUSED; only category, components, TTL; components are replaced wholesale; category of an APPROVED template cannot change; APPROVED: 1 edit per 24 h and 10 per 30 days; REJECTED/PAUSED: unlimited; an edited approved/paused template is re-reviewed |
| Delete | `DELETE /{waba}/message_templates?name=` deletes every language; `name`+`hsm_id` deletes one; approved name cannot be reused for 30 days; DISABLED cannot be deleted; undelivered deletes go `PENDING_DELETION` |
| Rates / counts | 100 template creations per Messaging account per hour; 250 templates unverified, 6,000 verified; inactive 12 months = archived |
| Statuses | APPROVED, PENDING, REJECTED, PAUSED, PENDING_DELETION, DISABLED |
| Not stated by Meta (WARN level only) | the list of rejection reason codes, adjacent-variable rule, variable-to-word ratio |

## Review Focus

Inputs and conditions the spec implies but does not test; each has a test in the named task.

1. Variable at the very start or end of the body, or `{{1}}` and `{{3}}` with no `{{2}}`: Meta rejects it hours later; the merchant should be told before submitting, in Arabic, pointing at the field (Task 1).
2. Editing an APPROVED template a second time inside 24 h, or an 11th time in 30 days: blocked locally with the exact time it unlocks, never a raw Meta error (Task 3, 4).
3. Meta's status webhook arrives BEFORE our own save of the submission (submit response slow): the row must not stay PENDING forever (Task 6).
4. Meta recategorises on submit (UTILITY comes back MARKETING): store Meta's category, tell the merchant what it changes (opt-in, cost, campaigns), never show the requested one (Task 3, 8).
5. Deleting a template that a scheduled/running campaign or queued message still uses, or deleting twice, or deleting a DISABLED one: refused with a plain reason (Task 4).
6. Two taps on "submit" or two staff tabs: same name+language must be a local 409 before any Meta call (Task 4).
7. Merchant with no connected number, with a shared number only, or with an unusable token: each gets its own plain message, not an empty list (Task 5, 8, 12).

## File Structure

| File | Responsibility |
|---|---|
| Create `src/core/meta/template-rules.ts` | Meta limits as constants + `checkTemplate()`; pure, imported by server and web |
| Create `src/core/template-draft.ts` | `TemplateDraft` (what the screen/Smart Layer edits), `toMetaComponents`, `fromStoredComponents`, `payloadHash` |
| Modify `src/core/meta/templates-api.ts` | add `editTemplate`, `deleteTemplate`, return Meta template `id`, keep `categoryConfirmed` |
| Modify `src/core/do-migrations.ts` | v42: `templates.meta_id`, `templates.label`, `template_edits` log |
| Modify `src/core/workspace-do.ts` | template rows carry id/label/edits; `getTemplate`, `recordTemplateEdit`, `removeTemplate`, `templateInUse`, `pendingTemplates` |
| Create `src/core/templates-service.ts` | `createTemplate`, `editTemplate`, `deleteTemplate`, `checkOnly`, `syncTemplates`, `installDefaults`, `refreshPending` returning typed results |
| Create `src/core/template-advice.ts` | rejection reason -> plain Egyptian Arabic / English advice |
| Create `src/core/starter-templates.ts` | per-isolate registry of the brand's starter set (`registerStarterSet`) |
| Modify `src/routes/templates.ts` | thin routes over the service |
| Modify `src/core/api/contract.ts`, `src/core/identity/scopes.ts` | additive DTO fields, new route scope entries |
| Modify `src/core/meta/webhook-schema.ts`, `src/index.ts`, `src/core/numbers/numbers.ts`, `src/core/scheduler.ts` | webhook template id + PENDING_DELETION, connect hook, stale-PENDING sweep |
| Create `web/src/components/TemplatesScreen.tsx`, `TemplateEditor.tsx`, `TemplateDetail.tsx`, `TemplateBubble.tsx` | list, editor, detail (status, reason, edit/delete), WhatsApp-style preview |
| Modify `web/src/data/api.ts`, `web/src/data/source.ts`, `web/src/components/Rail.tsx`, `web/src/App.tsx`, `web/src/i18n.ts`, `web/src/styles.css` | data layer, nav, copy (ar + en), styles |
| Modify/create `capabilities/templates.*.capability.json` (+ `operator.shared-template-requests`) | capability registry entries in the pr 69 schema, one file per id (spec 6.8) |
| Modify `docs/help/{ar,en}/04-...md`, create `16-`/`17-` articles, `docs/help/README.md` | help with `capabilities: - <id>@<version>` front matter (spec 6.8b) |

---

### Task 1: Meta rule checker and template draft (pure modules)

**Files:**
- Create: `src/core/meta/template-rules.ts`, `src/core/template-draft.ts`
- Test: `test/template-rules.test.ts`, `test/template-draft.test.ts`

**Interfaces:**
- Produces:
  - `export const META_LIMITS` (the table above as numbers: `NAME_MAX=512, BODY_MAX=1024, HEADER_TEXT_MAX=60, HEADER_VARS_MAX=1, FOOTER_MAX=60, BUTTONS_MAX=10, QR_MAX=10, QR_TEXT_MAX=25, URL_MAX=2, URL_TEXT_MAX=25, URL_LEN_MAX=2000, PHONE_MAX=1, PHONE_TEXT_MAX=25, PHONE_NUM_MAX=20, COPY_EXAMPLE_MAX=20, OTP_PARAM_MAX=15`).
  - `type TemplateDraft = { name: string; label: string; language: 'ar'|'en'; category: 'UTILITY'|'MARKETING'|'AUTHENTICATION'; header: { text: string; example?: string } | null; body: { text: string; examples: string[] }; footer: string | null; buttons: DraftButton[]; auth?: { expiryMinutes: number | null; securityRecommendation: boolean } }`
  - `type DraftButton = { type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string; example?: string } | { type: 'PHONE_NUMBER'; text: string; phone: string } | { type: 'COPY_CODE'; example: string }`
  - `type RuleIssue = { code: RuleCode; severity: 'error' | 'warning'; field: 'name'|'header'|'body'|'footer'|'buttons'|'category'|'examples'; params?: Record<string, string|number> }` and `checkTemplate(d: TemplateDraft, existing?: { name: string; language: string; bodyText: string; footer: string | null }[]): RuleIssue[]`
  - `toMetaComponents(d: TemplateDraft): unknown[]` (positional examples as `example.body_text=[[...]]`, `example.header_text=[...]`, URL `example=[...]`; AUTHENTICATION becomes `BODY{add_security_recommendation}`, `FOOTER{code_expiration_minutes}`, `BUTTONS[OTP COPY_CODE]` exactly like `EBDA_DEFAULT_TEMPLATES`), `fromStoredComponents(c: StoredComponent[], meta: {name; language; category; label}): TemplateDraft` (round-trips for edit), `payloadHash(d: TemplateDraft): Promise<string>` (hex SHA-256 of canonical JSON, keys sorted).
- Consumes: `StoredComponent` from `src/core/templates.ts`.

Ruling TPL-MEDIA-1 to write in `docs/rulings/TPL-MEDIA-1.md`: v1 supports text headers only; image/video/document template headers need Meta's Resumable Upload handle and a media pipeline this plan does not build; existing sends of already-approved media-header templates keep working (`renderTemplate`). Cost if wrong: merchants wanting a product-image template must use the WhatsApp Manager once.

- [ ] **Step 1: Write failing tests in `test/template-rules.test.ts`.** Names and assertions: `body starting with a variable is an error` (`{{1}} شكراً` -> issue `variable_at_edge` severity error field body); `body ending with a variable is an error`; `non-sequential variables ({{1}},{{3}}) -> variable_gap`; `missing example for a variable -> example_missing` with `params.index`; `body over 1024 -> body_too_long` (1025 chars fails, 1024 passes); `header 61 chars fails, 60 passes; two header variables fail`; `footer with a variable fails`; `# $ % inside a variable example -> example_bad_chars`; `buttons: 11 total fails; 3 URL fails; quick reply between two URLs -> qr_groups`; `button text 26 chars fails, 25 passes`; `url with a variable not at the end -> url_variable_position`; `AUTHENTICATION with a URL or emoji in anything -> auth_forbidden_content`, `expiryMinutes` outside 1..90 -> error (verify range against Meta's authentication doc when implementing, else drop the upper bound and keep it a warning); `UTILITY body containing خصم / عرض / تخفيض / % off / sale -> category_looks_promotional` severity WARNING suggesting MARKETING; `duplicate body+footer of another template (non-AUTH) -> duplicate_body` error; `a clean Egyptian Arabic shipping template -> []`; `name Bad Name! -> name_format`. Also assert every `RuleCode` has an Arabic and English message (see Step 3).
- [ ] **Step 2: Write failing tests in `test/template-draft.test.ts`:** `toMetaComponents(shippingDraft)` deep-equals the components of `EBDA_DEFAULT_TEMPLATES[2]`; `fromStoredComponents(toMetaComponents(d))` equals `d` for UTILITY with buttons and for AUTHENTICATION; `payloadHash` is identical for key-reordered drafts and differs when one example changes.
- [ ] **Step 3: Implement** both modules. `checkTemplate` is a list of small rule functions, each returning `RuleIssue[]`; messages are NOT in the module (codes + params only); add `src/core/meta/template-rule-copy.ts` with `ruleMessage(issue, lang): string` (Egyptian Arabic full sentence first, English second), the single source for screen and assistant.
- [ ] **Step 4: Run** `npx vitest run test/template-rules.test.ts test/template-draft.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(templates): meta rule checker and draft builder (pure)`.

### Task 2: Meta client for edit, delete and template ids

**Files:**
- Modify: `src/core/meta/templates-api.ts`
- Test: `test/templates-api.test.ts` (new; pattern of `test/shared-templates.test.ts` using `graphStub`)

**Interfaces:**
- Produces: `MetaTemplate` gains `id: string`; `submitTemplate(...)` value gains `id: string`; `editTemplate(a: Auth, templateId: string, body: { category?: string; components: unknown[] }): Promise<TemplatesApiResult<{ status: string }>>` (POST `/{graphVersion}/{templateId}`); `deleteTemplate(a: Auth, p: { name: string; metaId?: string }): Promise<TemplatesApiResult<{ deleted: true }>>` (DELETE `/{waba}/message_templates?name=` plus `&hsm_id=` when `metaId` is given so ONE language is removed, never all). `fetchTemplates` requests the `id` field.
- Consumes: `fetchWithTimeout`, existing `TemplatesApiResult`.

- [ ] **Step 1: Failing tests:** `editTemplate posts components to /v25.0/{id} with the bearer token`; `deleteTemplate with metaId sends name AND hsm_id` (assert URL query), `without metaId sends only name`; `a Graph 4xx returns ok:false retryable:false with Meta's error_user_msg`, `429/5xx retryable:true`; `fetchTemplates asks for fields including id`.
- [ ] **Step 2: Run** `npx vitest run test/templates-api.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the two functions beside `submitTemplate`, same timeout/labels (`meta.templates.edit`, `meta.templates.delete`); `no-raw-fetch.test.ts` must stay green (use `fetchWithTimeout`).
- [ ] **Step 4: Run** the new test plus `test/shared-templates.test.ts` and `test/no-raw-fetch.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(templates): meta edit and delete calls, template id on list and submit`.

### Task 3: DO migration and workspace template storage

**Files:**
- Modify: `src/core/do-migrations.ts` (append v42), `src/core/workspace-do.ts` (template methods near line 882), `src/core/meta/webhook-schema.ts` (`TemplateStatusEvent` gains `templateId: string | null`, status map gains `PENDING_DELETION`), `src/core/api/contract.ts` (`templateDto` status enum gains `PENDING_DELETION`)
- Test: `test/templates-store.test.ts`; extend `test/migrations-additive.test.ts` expectations only if it enumerates versions

**Interfaces:**
- Produces (migration v42, additive): `ALTER TABLE templates ADD COLUMN meta_id TEXT; ALTER TABLE templates ADD COLUMN label TEXT; ALTER TABLE templates ADD COLUMN submitted_at INTEGER; CREATE TABLE template_edits (id INTEGER PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX template_edits_lookup ON template_edits (name, language, at);`
- Produces on `WorkspaceDO`: `saveSubmittedTemplate(t: { name; language; category; status; components; metaId: string | null; label: string | null })` (stores Meta's CONFIRMED category, sets `submitted_at`); `getTemplate(name, language): Promise<TemplateRow | null>` with `{ metaId, label, status, category, components, rejectedReason, updatedAt }`; `recordTemplateEdit(name, language, at)`; `editAllowance(name, language, now): Promise<{ allowed: true } | { allowed: false; reason: 'status' | 'daily' | 'monthly'; retryAt: number | null }>` implementing Meta's rule (APPROVED: 1 per 24 h, 10 per 30 days; REJECTED/PAUSED unlimited; any other status not editable); `removeTemplate(name, language)`; `templateInUse(name, language): Promise<'campaign' | 'queued' | null>` (campaign statuses `draft|scheduled|running|paused`, messages `queued|retry`); `pendingTemplates(olderThanMs): Promise<{name; language; metaId}[]>`; `applyTemplateStatus` additionally stores `meta_id` when the event carries one and maps Meta's reason `NONE`/empty to `null` and clears the reason on APPROVED.
- `listTemplates()` DTO gains optional `label`, `components`, `updatedAt`, `editAllowance` fields (contract additive: `templateDto` fields `.optional()`).

- [ ] **Step 1: Failing tests** (real DO via `exec`/`rows` helpers): `v42 adds columns and keeps existing rows`; `saveSubmittedTemplate stores Meta's confirmed category, not the requested one` (UTILITY requested, MARKETING confirmed -> MARKETING); `editAllowance: approved edited 5 s ago -> daily with retryAt = at+24h; 10 edits in 30 days -> monthly with retryAt = oldest+30d; REJECTED never blocked; PENDING -> status`; `applyTemplateStatus stores meta_id from the event and clears reason on APPROVED`; `templateInUse sees a scheduled campaign and a queued message`; `template_edits is additive` (`destructiveStatements` empty).
- [ ] **Step 2: Run** `npx vitest run test/templates-store.test.ts test/migrations-additive.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the migration and methods; edit-allowance is pure SQL over `template_edits`.
- [ ] **Step 4: Run** both plus `test/templates.test.ts` (must still pass unchanged) -> PASS.
- [ ] **Step 5: Commit** `feat(templates): meta id, label and edit log on workspace templates`.

### Task 4: Templates service (one API for screen and Smart Layer)

**Files:**
- Create: `src/core/templates-service.ts`
- Test: `test/templates-service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`checkTemplate`, `toMetaComponents`, `payloadHash`), Task 2 (Meta calls), Task 3 (DO methods), `graphTokenFor`/`TokenUnavailable` from `src/core/numbers/token.ts`.
- Produces (all take `ctx: { env: Env; ws: DurableObjectStub<WorkspaceDO>; workspaceId: string; number: { phoneNumberId: string; wabaId: string } }`):
  - `type Failure = { ok: false; reason: 'invalid' | 'exists' | 'not_found' | 'not_editable' | 'edit_limit' | 'in_use' | 'not_deletable' | 'payload_changed' | 'token_unavailable' | 'meta_unavailable' | 'meta_rejected'; issues?: RuleIssue[]; retryAt?: number; message?: string }`
  - `checkOnly(ctx, draft): Promise<{ ok: true; issues: RuleIssue[]; payloadHash: string }>` (free; no Meta call)
  - `createTemplate(ctx, draft, opts?: { expectedHash?: string }): Promise<{ ok: true; name; language; status; category; categoryChanged: boolean } | Failure>`: runs `checkOnly` (any error issue -> `invalid`), `expectedHash` mismatch -> `payload_changed`, local `exists` before Meta, submits, saves with Meta's category.
  - `editTemplate(ctx, draft, opts?: { expectedHash?: string }): Promise<{ ok: true; status: string } | Failure>`: needs a stored `metaId` (else refresh by name first), `editAllowance`, category change refused for APPROVED, then Meta edit, then `recordTemplateEdit`, status becomes what Meta answered.
  - `deleteTemplate(ctx, p: { name: string; language: string }): Promise<{ ok: true } | Failure>`: refuses `DISABLED` (`not_deletable`) and `templateInUse` (`in_use`); deletes ONE language via `metaId`; Meta "already gone" counts as success; removes the row.
  - `syncTemplates(ctx)`, `installDefaults(ctx, seeds)` (moved out of the route; same `{submitted, skipped, failed}` result), `refreshPending(ctx, olderThanMs)`.

- [ ] **Step 1: Failing tests** (graphStub): `createTemplate submits toMetaComponents output and stores PENDING`; `error issue -> invalid, Graph never called`; `second create of same name+language -> exists, Graph never called`; `expectedHash mismatch -> payload_changed`; `Meta answers MARKETING for requested UTILITY -> categoryChanged true and stored MARKETING`; `editTemplate on APPROVED within 24 h -> edit_limit with retryAt`; `edit of APPROVED with a different category -> not_editable`; `edit of REJECTED succeeds and records an edit`; `deleteTemplate with a scheduled campaign -> in_use`; `delete DISABLED -> not_deletable`; `delete sends hsm_id`; `delete twice -> second is not_found`; `token unavailable -> token_unavailable, no Graph call`; `installDefaults skips what exists` (port of the existing route test).
- [ ] **Step 2: Run** `npx vitest run test/templates-service.test.ts` -> FAIL.
- [ ] **Step 3: Implement** each function as small steps; failures are values, never throws; all Meta text is passed through untouched in `message` and mapped to Arabic only in the screen via the reason code.
- [ ] **Step 4: Run** the service test -> PASS.
- [ ] **Step 5: Commit** `feat(templates): templates service for create, edit, delete, check and sync`.

### Task 5: Routes, contract and scopes

**Files:**
- Modify: `src/routes/templates.ts`, `src/core/api/contract.ts`, `src/core/identity/scopes.ts` (+ the route table near line 631 of contract.ts), `src/index.ts` (only the `registerStarterSet` call, see Task 7)
- Test: extend `test/templates.test.ts`; `test/contract.test.ts` and the scopes test stay green

**Interfaces:**
- Produces routes (all under `/stores/:storeId`, writes need `managesStore`, all need an active number; no number = 404 `not_found` with body `{ error: 'not_found', message: 'no_active_number' }` so the screen can tell it from other 404s):
  - `GET /templates` (existing, richer DTO) · `GET /templates/:name/:language` (detail incl. components + `editAllowance`)
  - `POST /templates/check` body `templateDraft` -> `{ issues: RuleIssue[], payloadHash }` (free, staff allowed)
  - `POST /templates` body `templateDraft` + optional `expectedHash` -> 201 `{ name, language, status, category, categoryChanged }` (the old `{name,language,category,components}` body keeps working: accept both shapes, old one is converted by `fromStoredComponents`)
  - `PUT /templates/:name/:language` body `templateDraft` + optional `expectedHash` -> 200 `{ status }`
  - `DELETE /templates/:name/:language` -> 204
  - `POST /templates/sync`, `POST /templates/install-defaults` (existing paths, now over the service)
  - Failure mapping: `invalid` 400 `{ error: 'invalid_request', issues }`, `exists` 409, `edit_limit` 409 `{ retryAt }`, `in_use` 409, `payload_changed` 409, `not_editable|not_deletable` 409, `token_unavailable|meta_unavailable` 503 `rate_limited`, `meta_rejected` 400 with Meta's message.
- Scopes: every new route gets an entry (`GET` detail `templates:read`; `check` `templates:read`; `POST/PUT/DELETE` `person_only`) so integrator tokens never write templates; add the ids to the route table at contract.ts:631.

- [ ] **Step 1: Failing tests** in `test/templates.test.ts`: `POST /templates/check returns issues and a hash, never calls Graph`; `POST /templates with the new draft body submits and 201`; `old body shape still works (existing tests unchanged)`; `staff may check and read, may not create/edit/delete (403)`; `integrator api key cannot write (scopes)`; `PUT within 24 h of the last edit -> 409 with retryAt`; `DELETE in-use -> 409 in_use`, `DELETE ok -> 204 and row gone`; `no number -> 404 no_active_number`.
- [ ] **Step 2: Run** `npx vitest run test/templates.test.ts test/contract.test.ts` -> FAIL.
- [ ] **Step 3: Implement** the routes as thin wrappers (parse with Zod `templateDraftSchema` exported from the contract, call service, map failure). Add an audit log line per write using the existing pattern (`console.log(JSON.stringify({ audit: 'template_submitted', ... }))`, name/language/category only).
- [ ] **Step 4: Run** the same tests plus the identity scopes test -> PASS.
- [ ] **Step 5: Commit** `feat(templates): merchant template routes over the service`.

### Task 6: Status tracking, rejection advice and stale-PENDING sweep

**Files:**
- Create: `src/core/template-advice.ts`
- Modify: `src/core/meta/webhook-schema.ts` (`extractTemplateStatuses` returns `templateId`), `src/index.ts` (pass it to `applyTemplateStatus`), `src/core/scheduler.ts` (sweep), `src/core/api/contract.ts` (`templateDto.advice` optional `{ ar: string; en: string; kind: 'format'|'policy'|'length'|'duplicate'|'category'|'unknown' }`)
- Test: `test/template-advice.test.ts`, `test/templates-status.test.ts`

**Interfaces:**
- Produces `rejectionAdvice(reason: string | null, status: string): { ar: string; en: string; kind: ... } | null`. Mapping keyed on Meta's reason codes AND on the four documented rejection themes; an unknown code returns the generic advice (`kind: 'unknown'`) and the raw code is still shown. The set of codes Meta actually emits is not listed in its docs: the test fixture `test/fixtures/template-reasons.json` starts with the codes the existing webhook tests use plus `INVALID_FORMAT`, `ABUSIVE_CONTENT`, `TAG_CONTENT_MISMATCH`, `INCORRECT_CATEGORY`, `SCAM`, `NONE` and is extended in Task 14 with real captured values.
- `refreshPending(ctx, olderThanMs)` (service, Task 4) re-reads PENDING templates older than 1 h by name through `fetchTemplates({name})`; the scheduler calls it for workspaces that have a PENDING row (a D1 mirror flag `templates_pending` is NOT added: the DO alarm already visits each workspace, so the sweep is a DO-side check).

- [ ] **Step 1: Failing tests:** `advice for INVALID_FORMAT is Arabic first, mentions fixing braces/variables`; `advice never contains the raw merchant body`; `a status webhook that arrives before saveSubmittedTemplate leaves a row that the sweep fixes to APPROVED` (order: webhook -> save PENDING -> `refreshPending` with Graph answering APPROVED -> row APPROVED); `webhook for an unknown template is still ignored and does not throw`; `PENDING_DELETION event removes nothing but marks status`; `webhook reason NONE -> rejected_reason null`.
- [ ] **Step 2: Run** `npx vitest run test/template-advice.test.ts test/templates-status.test.ts` -> FAIL.
- [ ] **Step 3: Implement** advice, `templateId` extraction, scheduler hook (existing alarm cadence, no new Neon/D1 polling; one Graph read per stale name, capped 20 per run), and expose `advice` in `listTemplates`.
- [ ] **Step 4: Run** both plus `test/templates.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(templates): rejection advice and stale pending sweep`.

### Task 7: Starter templates and Meta sync on number connect (A3)

**Files:**
- Create: `src/core/starter-templates.ts`
- Modify: `src/core/numbers/numbers.ts` (`onNumberConnected`, line ~104), `src/index.ts` (register the brand starter set beside `templatesRoutes(PACK.templates)`), `src/routes/templates.ts` (install-defaults reuses it)
- Test: `test/templates-on-connect.test.ts` (patterns of `test/numbers-connect.test.ts`)

**Interfaces:**
- Produces `registerStarterSet(seeds: readonly TemplateSeed[]): void`, `starterSet(): readonly TemplateSeed[]`, and `installStarterOnConnect(env: Env, n: { workspaceId: string; wabaId: string }): Promise<'done' | 'partial' | 'skipped'>`: sync from Meta FIRST (existing templates are adopted, never resubmitted), then submit only missing seeds, write DO `store_state` key `templates.starter:<wabaId>` = `done` only when nothing failed. Never throws into `connectNumber`; failure logs `alert('starter_templates_failed', { workspaceId })`.
- `onNumberConnected` calls it through `ctx.waitUntil`-style non-blocking invocation available to `connectNumber` (use the same mechanism the file already uses for `refreshPricing` side effects; if none, the route passes `c.executionCtx.waitUntil`). Idempotent because `resumeSetup` re-enters it.
- `POST /templates/install-defaults` stays the manual/retry path; the screen (Task 8) calls it once when the list is empty and the marker is not `done`.

- [ ] **Step 1: Failing tests:** `connecting a number syncs existing templates then submits only the missing starters`; `a template already at Meta is adopted, not resubmitted`; `Graph down during install: connect still succeeds, marker not set, alert logged`; `resumeSetup re-runs without duplicates`; `shared-number workspaces never get starters` (no own WABA); `GET /templates exposes starterInstalled boolean`.
- [ ] **Step 2: Run** `npx vitest run test/templates-on-connect.test.ts test/numbers-connect.test.ts` -> FAIL.
- [ ] **Step 3: Implement** as described; the route's inline loop is replaced by the service `installDefaults`.
- [ ] **Step 4: Run** both plus `test/templates.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(templates): starter set and meta sync when a number connects`.

### Task 8: Templates screen, list and status (A1, A2)

**Files:**
- Create: `web/src/components/TemplatesScreen.tsx`, `web/src/components/TemplateBubble.tsx`
- Modify: `web/src/data/api.ts` (+ `source.ts` type `TemplatesApi`), `web/src/components/Rail.tsx` (`View` gains `'templates'`, icon `FileText`), `web/src/App.tsx` (render branch like `campaigns`), `web/src/i18n.ts` (ar + en, keys prefixed `tpl`), `web/src/styles.css`
- Test: `web/src/TemplatesScreen.test.tsx`

**Interfaces:**
- Produces `TemplatesApi = { list(): Promise<TemplateDto[]>; detail(name, lang): Promise<TemplateDto>; check(d: TemplateDraft): Promise<{ issues: RuleIssue[]; payloadHash: string }>; create(d, expectedHash?): Promise<CreateResult>; edit(name, lang, d, expectedHash?): Promise<{ status: string }>; remove(name, lang): Promise<void>; sync(): Promise<{ upserted: number; removed: number }>; installDefaults(): Promise<{ submitted: string[]; skipped: string[]; failed: string[] }> }` in `web/src/data/api.ts`, validated with the contract Zod schemas like the other calls.
- Screen: a table (cards on phone) of name (label first, raw name `dir=ltr` second), language, category chip, status chip (APPROVED "شغّال", PENDING "قيد مراجعة ميتا (لحد يوم)", REJECTED "اتّرفض", PAUSED "موقوف مؤقتًا", DISABLED "متعطّل", PENDING_DELETION "بيتمسح"), updated date; a "مزامنة مع ميتا" button, a "قالب جديد" button (owner only; staff see read-only), empty state that auto-calls `installDefaults` once when `starterInstalled` is false and tells the merchant in a full sentence what is happening; states for no number ("اربط رقم واتساب الأول" with link to Numbers), token problem, shared-number (Task 12). Arabic digits per `WesternDigits.test.tsx` rules; Ebda gold accents only, no orange (use existing CSS tokens); `<table>` uses `scope` headers like `SharedTemplatesPanel`; focus order and `aria-live` for status changes.

- [ ] **Step 1: Failing tests (jsdom, fake `TemplatesApi`):** `lists templates with Arabic status words`; `a rejected row shows the advice sentence under it`; `staff see no "new template" button`; `empty list triggers installDefaults exactly once and then reloads`; `no active number shows the connect prompt, not an empty table`; `sync button shows "Synced N" and reloads`; `Rail shows Templates and navigation renders the screen`; `en strings exist for every ar key` (the repo's i18n parity test pattern).
- [ ] **Step 2: Run** `npx vitest run web/src/TemplatesScreen.test.tsx` -> FAIL.
- [ ] **Step 3: Implement** screen, bubble preview (renders body with example values substituted, RTL, WhatsApp-like green-free neutral card), data layer and wiring. Copy rule: product name "Ebda Chat"; no jargon without a plain explanation (UTILITY = "رسائل خدمة", MARKETING = "رسائل تسويق", AUTHENTICATION = "أكواد التحقق").
- [ ] **Step 4: Run** the test plus `web/src/App.test.tsx` and `web/src/data/api.test.ts` -> PASS.
- [ ] **Step 5: Commit** `feat(web): templates screen with status and starter install`.

### Task 9: Template editor with live Meta checks (A1)

**Files:**
- Create: `web/src/components/TemplateEditor.tsx`
- Modify: `web/src/components/TemplatesScreen.tsx` (open editor), `web/src/i18n.ts`, `web/src/styles.css`
- Test: `web/src/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: `TemplatesApi.check/create`, `checkTemplate` + `ruleMessage` imported from `src/core/...` for instant client-side feedback (the server `check` stays the gate).
- Produces `<TemplateEditor t lang api existing onSaved onClose draft? mode='create'|'edit' />`. Flow: pick what it is for (three plain cards: "رسالة خدمة عن الطلب" / "رسالة تسويق" / "كود تحقق"), language, title (merchant's own words; `name` auto-derived `snake_case` ASCII with a short suffix, shown only under "إعدادات متقدمة"), body textarea with an "add variable" button inserting `{{n}}` and one example field per variable (required), optional header text (60) / footer (60) / buttons (add quick reply, URL, phone, copy code, grouped as Meta requires, counters 25/60/1024), AUTHENTICATION shows only expiry minutes + security recommendation toggle. Issues render next to the field via `ruleMessage`, errors block the submit button, warnings (e.g. promotional UTILITY) can be acknowledged. Submit opens a confirm step showing the bubble preview plus "ده هيتبعت لميتا للمراجعة ومش هينفع تسحبه بعد كده، تقدر تعدّله أو تمسحه" and a confirm button (the `confirm` policy in the UI); after 201 shows "اتبعت لميتا. بتاخد لحد 24 ساعة." and, when `categoryChanged`, the recategorisation explanation (opt-in needed, price changes, campaigns).

- [ ] **Step 1: Failing tests:** `typing a body that starts with a variable shows the Arabic error beside the body and disables submit`; `adding {{1}} adds a required example field`; `an 11th button is impossible: the add button disables at 10 and URL at 2`; `quick reply cannot be inserted between two URL buttons`; `submit shows the confirm step and calls create only after confirm, passing expectedHash from the last check`; `server 409 exists shows "عندك قالب بنفس الاسم واللغة"`; `categoryChanged shows the recategorisation notice`; `AUTHENTICATION hides the free body field`; `Arabic and English both render without missing keys`.
- [ ] **Step 2: Run** `npx vitest run web/src/TemplateEditor.test.tsx` -> FAIL.
- [ ] **Step 3: Implement** the component and its draft state reducer (one pure `editorReducer` exported for tests).
- [ ] **Step 4: Run** the test plus `TemplatesScreen.test.tsx` -> PASS.
- [ ] **Step 5: Commit** `feat(web): template editor with live meta rule checks and confirm step`.

### Task 10: Detail, rejection reason, edit, resubmit and delete (A1, A4)

**Files:**
- Create: `web/src/components/TemplateDetail.tsx`
- Modify: `web/src/components/TemplatesScreen.tsx`, `web/src/i18n.ts`
- Test: `web/src/TemplateDetail.test.tsx`

**Interfaces:**
- Consumes: `TemplatesApi.detail/edit/remove`, `rejectionAdvice` result carried in the DTO, `editAllowance` in the DTO.
- Produces `<TemplateDetail ... />`: status timeline text, preview bubble, Meta's rejection reason in plain Arabic (advice) with the raw code in a `<details>`, buttons "عدّل وابعت تاني" (opens the editor in `mode='edit'` pre-filled via `fromStoredComponents`; for REJECTED the category is editable, for APPROVED it is locked with the reason), disabled-with-reason states ("تقدر تعدّل تاني بعد <time>" from `editAllowance.retryAt`, "القالب ده متعطّل من ميتا ومينفعش يتمسح"), delete with a confirm dialog that states the 30-day name-reuse rule for approved templates and that all campaigns using it must finish first (409 `in_use` shown as that sentence).

- [ ] **Step 1: Failing tests:** `rejected detail shows advice and an edit-and-resubmit button`; `approved detail locks category and shows the 24 h wait text after a recent edit`; `edit calls api.edit with expectedHash and shows PENDING afterwards`; `delete asks for confirmation and mentions 30 days for approved`; `409 in_use shows the campaign sentence`; `DISABLED has no delete button`; `staff see detail read-only`.
- [ ] **Step 2: Run** `npx vitest run web/src/TemplateDetail.test.tsx` -> FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it plus `TemplateEditor.test.tsx` -> PASS.
- [ ] **Step 5: Commit** `feat(web): template detail with rejection reason, edit and delete`.

### Task 11: Use approved templates well in campaigns and conversations

**Files:**
- Modify: `web/src/components/ChatPane.tsx` (line ~110 uses `t.templateNames[name] ?? name`), `web/src/components/CampaignsScreen.tsx` (~79), `web/src/components/CampaignForm.tsx` (empty state, ~118 `noTemplates`), `web/src/i18n.ts`
- Test: extend `web/src/CampaignsScreen.test.tsx`, add `web/src/TemplateLabels.test.tsx`

**Interfaces:** the display name of a template is `label ?? t.templateNames[name] ?? name` through one helper `templateTitle(t: Strings, x: { name: string; label?: string | null }): string` in `web/src/lib/format.ts`. `CampaignForm` empty state links to the Templates screen ("مفيش قالب تسويق معتمد لسه. اعمل واحد من صفحة القوالب"), and PAUSED/PENDING marketing templates appear greyed with the reason instead of vanishing.

- [ ] **Step 1: Failing tests:** `a custom template with a label shows the label in the picker, the campaign list and the chat template popover`; `empty marketing list links to Templates`; `a paused marketing template is shown disabled with "موقوف مؤقتًا"`.
- [ ] **Step 2: Run** `npx vitest run web/src/TemplateLabels.test.tsx web/src/CampaignsScreen.test.tsx` -> FAIL.
- [ ] **Step 3: Implement** helper and call sites; no server change (the campaign server already re-checks APPROVED at `core/campaigns/campaigns.ts:161`).
- [ ] **Step 4: Run** the two tests plus `ChatPane`-related existing web tests -> PASS.
- [ ] **Step 5: Commit** `feat(web): show template labels and link campaigns to the templates screen`.

### Task 12: Shared-number stores (A18) 

Ruling `WA-SHARED-NOCAMP-1` (marketing is never sendable from the shared number) stays; the audit (item 16) says KEEP and surface the upgrade. This task makes that visible and adds the missing merchant path for utility/authentication on the platform line.

**Files:**
- Modify: `src/routes/templates.ts`, `src/core/shared/shared-templates.ts` (store-facing list + request helpers), `src/routes/operator.ts` (list requests), `web/src/components/TemplatesScreen.tsx`, `web/src/components/SharedTemplatesPanel.tsx` (operator sees requests), `web/src/i18n.ts`, new D1 migration `migrations/d1/0032_shared_template_requests.sql`
- Test: `test/shared-template-requests.test.ts`, `web/src/TemplatesShared.test.tsx`

**Interfaces:**
- D1 table `shared_template_requests (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, language TEXT NOT NULL, category TEXT NOT NULL CHECK (category IN ('UTILITY','AUTHENTICATION')), body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, decided_at INTEGER)` plus an index on `(workspace_id, status)`.
- Routes (member of the shared number only; else 404): `GET /stores/:storeId/templates/shared` -> platform templates that are sendable now (`sharedTemplateSendable` rule: APPROVED and UTILITY/AUTHENTICATION), name + body + paramCount only; `POST /stores/:storeId/templates/shared-requests` body `{ name, language, category: 'UTILITY'|'AUTHENTICATION', body }` -> 201, max 5 open per workspace (429-style `rate_limited`), MARKETING refused 400 `marketing_not_on_shared_number`; `GET .../shared-requests` own requests with status. Operator: `GET /operator/shared-template-requests`; deciding stays the existing submit path, which marks the matching request `done` (`status`: `open|done|declined`).
- Screen for a shared-number-only store: banner "إنت شغّال على الرقم المشترك: تقدر تستخدم القوالب الجاهزة هنا، لكن الرسائل التسويقية والحملات محتاجة رقمك الخاص" with a button to Numbers; list of platform templates (read-only); "اطلب قالب خدمة" form (utility/auth only); own requests with status.

- [ ] **Step 1: Failing tests:** `shared member lists only APPROVED UTILITY/AUTHENTICATION platform templates and no marketing`; `non-member -> 404`; `request with MARKETING -> 400`; `6th open request -> refused`; `operator list shows requests with workspace id`; `own-number store gets 404 on /templates/shared`; web: `banner links to Numbers`, `request form submits and shows "اتبعت للفريق"`, `marketing option is absent`.
- [ ] **Step 2: Run** `npx vitest run test/shared-template-requests.test.ts web/src/TemplatesShared.test.tsx` -> FAIL.
- [ ] **Step 3: Implement.** The new operator route is covered by the registry entry `operator.shared-template-requests` (policy `forbidden`, operator reason copied from `operator.shared-templates`) created in Task 13; the self-service guard from ebda-foundation pr 69 recognises it by the `^/operator` route kind.
- [ ] **Step 4: Run** the two tests plus `test/shared-templates.test.ts` and `web/src/SharedTemplatesPanel.test.tsx` -> PASS.
- [ ] **Step 5: Commit** `feat(templates): shared-number stores see platform templates, request utility ones and learn why marketing needs their own number`.

### Task 13: Capability registry entries and help articles (spec 6.8, 6.8b, fix doc 04)

Follows ebda-foundation pr 69 (`docs/superpowers/plans/2026-11-14-charter-guards-registry-help.md`): one file per capability, `capabilities/<id>.capability.json`, validated by `capabilitySchema` from `@ebda/foundation` (camelCase fields; policy `free|preview|confirm|forbidden`; status `live|in-pr|planned`; undo class `reversible|compensating|irreversible|none|unclassified`, and `irreversible` is always `confirm` or `forbidden`). Prerequisite: pr 69 Task 15 (foundation v0.2.0 synced into this repo, the 172 Chat entries seeded) is merged. The seed never overwrites an existing file, so for ids that already exist this task EDITS the seeded file; it creates only the new ids. If pr 69 is not merged when this task starts, stop and report (do not write a parallel format).

**Files:**
- Modify (seeded by pr 69, edit in place): `capabilities/templates.list.capability.json`, `templates.create-submit`, `templates.sync`, `templates.install-defaults`, `templates.starter-on-connect`, `templates.edit-delete` (all `.capability.json`)
- Create: `capabilities/templates.shared-list.capability.json`, `capabilities/templates.shared-request.capability.json`, `capabilities/templates.shared-number-marketing.capability.json`, `capabilities/operator.shared-template-requests.capability.json`
- Leave as seeded: `templates.status-webhook` (system), `templates.shared-catalogue` and `operator.shared-templates` (operator), `templates.quality-rating` (planned), `templates.ai-writer` (stays `planned`, shipped by ebda-foundation pr 70 Phase D, which calls the routes below unchanged)
- Create help: `docs/help/ar/16-write-and-submit-a-template.md`, `docs/help/en/16-write-and-submit-a-template.md`, `docs/help/ar/17-template-review-and-rejections.md`, `docs/help/en/17-template-review-and-rejections.md`
- Modify: `docs/help/ar/04-templates-and-the-24-hour-window.md`, `docs/help/en/04-templates-and-the-24-hour-window.md`, `docs/help/README.md`, `capabilities/baselines/*.json` (only to REMOVE ids, never add)
- Test: `test/capabilities-templates.test.ts`

**Interfaces (the registry contract this plan guarantees; ids are the Chat catalogue ids, so pr 70's tool table keeps working):**

| id | status | policy | undo | api (guard-normalised) | help slug |
|---|---|---|---|---|---|
| `templates.list` | live, version 2 | free | none | `GET /stores/:storeId/templates`, `GET /stores/:storeId/templates/:name/:language` | `whatsapp/templates-and-the-24-hour-window` |
| `templates.sync` | live, version 2 | free | none | `POST /stores/:storeId/templates/sync` | same |
| `templates.create-submit` | live, version 2 | confirm | irreversible | `POST /stores/:storeId/templates`, `POST /stores/:storeId/templates/check` | `whatsapp/write-and-submit-a-template` |
| `templates.edit-delete` | live, version 2 (was planned) | confirm | irreversible | `PUT /stores/:storeId/templates/:name/:language`, `DELETE /stores/:storeId/templates/:name/:language` | `whatsapp/template-review-and-rejections` |
| `templates.install-defaults` | live, version 2 | confirm | irreversible | `POST /stores/:storeId/templates/install-defaults` | `whatsapp/templates-and-the-24-hour-window` |
| `templates.starter-on-connect` | live, version 2 (was planned) | free | none | none (system hook, screens `view:templates`) | same |
| `templates.shared-list` | live, version 1 | free | none | `GET /stores/:storeId/templates/shared`, `GET /stores/:storeId/templates/shared-requests` | same |
| `templates.shared-request` | live, version 1 | confirm | irreversible | `POST /stores/:storeId/templates/shared-requests` | same |
| `templates.shared-number-marketing` | live, version 1 | free | none | none (screen explains the refusal and links to Numbers; rule WA-SHARED-NOCAMP-1) | same |
| `operator.shared-template-requests` | live, version 1 | forbidden | none | `GET /operator/shared-template-requests` | none (`operatorReason.code` copied from the seeded `operator.shared-templates` entry, `validUnderRule: true`) |

Every live merchant entry carries `screens: ['view:templates']`, roles `['owner']` for writes and `['owner','staff']` for reads (staff may check, list, sync), `questions.ar` 3-6 and `questions.en` 1-3 (reuse and extend the seeded questions; add Franco spellings inside the Arabic list, the schema has no separate field), `versionDate: '2026-11-14'`, and `edgeCases` taken from this plan's Review Focus. Help article front matter (block list, the only list form pr 69's parser promises): `capabilities:` then one `- <id>@<version>` per line, plus `appPath: /templates`; guide 04 lists `templates.list@2`, `templates.sync@2`, `templates.install-defaults@2`, `templates.starter-on-connect@2`, `templates.shared-list@1`, `templates.shared-request@1`, `templates.shared-number-marketing@1`; guide 16 lists `templates.create-submit@2`; guide 17 lists `templates.edit-delete@2`.

Known guard friction to handle, not hide: pr 69's `policy-free-writes` rule flags a `free` entry whose api has a non-GET method, which `templates.sync` (POST, local state refreshed from Meta, harmless) and the `check` route (kept under `templates.create-submit`, so unaffected) bring up. Do not change `templates.sync` to `preview` to silence it. Run the guard; if it fires for `templates.sync`, ask the controller to add a read-only-POST allowance to pr 69's `guardConfigSchema` and meanwhile leave `templates.sync` in `capabilities/baselines/registry.json` (that baseline is shrink-only, so this is recorded debt, not a new exemption).

- [ ] **Step 1: Failing test `test/capabilities-templates.test.ts`** (imports the same vendored foundation modules as pr 69's Task 16 tests): every `capabilities/templates.*.capability.json` and `operator.shared-template-requests` file parses with `capabilitySchema` and `checkRegistry` returns no violation for those ids (other than baselined ones); every route registered by `templatesRoutes` and the new shared-request routes appears (normalised with `normalizeApi`) in exactly one entry's `api`; the confirm set above is exactly the set of entries whose api submits, edits or deletes at Meta or messages staff; `checkHelp` over `docs/help/{ar,en}` reports no `help-missing`, `help-twin-missing`, `help-unlinked` or `help-stale` for these ids; every `live` entry's `helpArticle` slug has a file in BOTH languages.
- [ ] **Step 2: Run** `npx vitest run test/capabilities-templates.test.ts` -> FAIL (entries unedited, articles missing).
- [ ] **Step 3: Edit and create the capability files** per the table (status flips, `version` 2 with `versionDate`, policy, undo, `api`, `screens`, `helpArticle`, questions, edge cases), and remove the matching ids from the `coverage`, `help` and `superadmin` baselines where this PR makes them pass.
- [ ] **Step 4: Write the articles.** Egyptian Arabic first, full sentences, faithful English. 16: choose a category, write the body with variables and examples, header/footer/button limits (the table above in merchant words), send for review, up to 24 h. 17: the statuses, reading a rejection in plain words (the four documented themes), edit and resubmit, the 24 h and 10-per-30-days edit limit on approved templates, deleting (30-day name rule, all-languages caution), recategorisation to marketing and what it changes. Rewrite 04 against the real Templates screen: remove "edit and resubmit under a new name", describe the starter set installed on connect and Sync, and add the shared-number section (marketing needs your own number; ask for a utility template). Add the front matter above to 04, 16, 17 and keep the "Last checked: 2026-11-14" footer; README table rows 16 and 17 and the front-matter keys.
- [ ] **Step 5: Run** `npx vitest run test/capabilities-templates.test.ts test/capability-registry.test.ts test/capability-routes.test.ts` -> PASS. Commit `docs(templates): capability entries and help articles, fix guide 04`. Cross-repo follow-up (not in this PR, name it in the PR body): ebda-store's `import-wa-help.mjs` must re-import guides 04, 16, 17 and re-pin the guide hashes in `tests/unit/support-wa-help-drift.test.ts`.

### Task 14: Docs parity, blast radius, full gate and live check

**Files:**
- Modify: `docs/messaging-core.md`, `docs/numbers.md`, `docs/shared-number.md`, `docs/site/ar/whatsapp/api.mdx`, `docs/site/en/whatsapp/api.mdx` (new routes, draft shape, error codes), `docs/store-feature-map.md` if it lists templates, `test/fixtures/template-reasons.json`
- Test: whole suite

- [ ] **Step 1: Blast-radius sweep.** One grep pass over `listTemplates|saveSubmittedTemplate|applyTemplateStatus|templateDto|submitTemplateRequest|install-defaults|rejected_reason|TemplateSeed|PENDING_DELETION` across `src/`, `web/`, `test/`, `docs/`, `scripts/`, `.github/`; fix every consumer (the backup export `src/core/backup-export.ts` and `test/backup-notes-tags-templates-uploads.test.ts` read the `templates` table: confirm the new columns are exported or deliberately excluded, with a test). State the result in the PR: `blast-radius: swept <ids> across <scopes> -> clean | found + fixed N`.
- [ ] **Step 2: Docs parity.** Update the docs listed above in this same PR; `docs/help/README.md` already done in Task 13.
- [ ] **Step 3: Gate.** `npm run typecheck`; `bash ~/.claude/scripts/host-lock.sh npm run test:ci` (or the repo's documented full-suite command); `npm audit` unchanged (no new dependency was added); web build `npm run build` in `web/` if the repo's CI does it. Expected: all green, no console noise (`console-quiet.test.ts`).
- [ ] **Step 4: After deploy (rule F), report both halves.** VERIFY: `curl` the Worker `/health` commit equals the tip of `main`; as a test store with an active number on the Ebda test WABA, drive the screen in Arabic: sync, open a template, run the live check, and (only with Ahmad's OK, because it is a real Meta submission) submit one `ebda_test_*` utility template, then confirm the webhook moves it to APPROVED/REJECTED and capture the real rejection reason string into `test/fixtures/template-reasons.json`; delete the test template. NOT VERIFIABLE until a real number connects: the on-connect starter install against a brand-new WABA; say so in the PR. Prod reads read-only.
- [ ] **Step 5: Commit** `docs(templates): api docs, blast-radius fixes and captured meta reasons`. Run `nohup ~/.claude/scripts/update-memory-pipeline.sh all > /dev/null 2>&1 & disown` per the repo rule.

---

## Self-Review

- **Spec coverage:** 7.2 screen (create/edit/submit, status + reason, resubmit, use in campaigns): Tasks 4-5, 8-11. 7.3 starter on connect + sync: Task 7. A1: 8-10; A2: 8; A3: 7; A4: 3-5, 10 (Meta edit/delete limits cited); A18: 12; doc 04 fix: 13. 6.7 same-API requirement: service + `check` + `expectedHash` (Task 4-5); the writer skill itself is the Smart Layer plan (registry entry `planned`). Policy `confirm` for submit/edit/delete/install: registry (Task 13) and the UI confirm step (Task 9, 10). 6.8 registry + 6.8b help: Task 13. Rejection explained in plain Egyptian Arabic: Task 6, 10. Webhook and sync: Task 3, 6.
- **Type consistency:** `TemplateDraft`, `RuleIssue`, `payloadHash`, `Failure`, `TemplatesApi` names are used identically across Tasks 1, 4, 5, 8-10; `editAllowance` shape is defined once in Task 3 and consumed in Tasks 4, 5, 10.
- **Open decisions made (Ahmad may override):** (1) text headers only in v1, media headers deferred (ruling TPL-MEDIA-1); (2) positional variables only; (3) merchant-facing `label` stored beside Meta's snake_case name, name auto-derived; (4) starter install is best-effort on connect with the screen as the retry path, no new cron; (5) shared-number stores get a utility/auth request path, marketing stays refused per WA-SHARED-NOCAMP-1; (6) registry entries follow ebda-foundation pr 69 exactly (one `.capability.json` per id, catalogue ids, `id@version` help links), and `templates.sync` may need a read-only-POST allowance in pr 69's guard; (7) Meta rejection code list is not in Meta's docs, so advice is keyed on the four documented themes with a generic fallback and real codes are captured in Task 14.
