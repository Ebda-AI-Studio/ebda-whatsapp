# Search as you type: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every search box in Ebda WhatsApp shows results as the user types, Arabic-aware, keyboard- and screen-reader-accessible, tenant-scoped, rate-limited and fast.

**Architecture:** One shared normaliser (`src/core/text-normalise.ts`, imported by server and web) decides matching on both sides. The workspace DO owns every search (FTS5 for messages and contact names, digit match for phones) behind tenant-scoped routes with a per-workspace token bucket. The web app has ONE hook (`useTypeahead`: 1st character, 150 ms debounce, AbortController, latest-only) and ONE component (`SearchBox`: ARIA combobox, highlighted matches, ar/en states) used by every screen.

**Tech Stack:** Cloudflare Workers + Hono, DO SQLite FTS5, React + Testing Library, vitest-pool-workers.

**Spec:** controller brief 2026-10-26 (Ahmad's requirement, same spec as Ebda Store): results from the 1st character (Arabic-aware via the normaliser), ~150 ms debounce, abort stale requests (never render an older query's results), keyboard nav + ARIA combobox, RTL, highlighted matches, loading/no-results states in Egyptian Arabic + English, tenant-scoped, rate-limited, no extra PII, typeahead p95 < 300 ms (DO FTS5). Controller additions: fix the inbox stale-overwrite first (PR #15); ONE shared normaliser for name/phone matching on server + client (phone: digits only, Arabic-Indic ٠-٩ folded to ASCII); never log raw queries containing phone numbers (mask them).

## Global Constraints
- Product name "Ebda WhatsApp"; no legacy strings (guard test); `src/core/**` never names Ebda.
- Tenant data only via `env.WORKSPACE_DO.get(idFromName(workspaceId))`; D1 holds no message content or names.
- Zod at every edge: `q` = trimmed string, 1-100 chars; `limit` 1-50 (typeahead default 20).
- Never log a query, a phone number or a message body; any error path that mentions a query goes through `maskPhones`.
- Copy in Egyptian Arabic full sentences + English (i18n.ts both languages, same keys).
- Debounce 150 ms (one constant, `SEARCH_DEBOUNCE_MS`, shared by web); search starts at 1 character.
- Rate limit per workspace: token bucket 20 searches/s, burst 40 → `429 rate_limited` (in-memory in the DO; bounded-stale by design: it resets when the DO is evicted, documented at the site).
- p95 < 300 ms per typeahead request at 5,000 conversations / 20,000 contacts (bench, opt-in `BENCH=1`, nightly).
- Heavy suites only under `lockf -k ~/.claude/locks/heavy-test.lock`; max 2 tracks; one PR per task through `merge-gate.sh`.

## Review Focus
1. A query of one Arabic letter with hamza/taa-marbuta variants (أ vs ا, ة vs ه, ى vs ي) matches names stored in the other form.
2. A phone typed with Arabic-Indic digits (٠١٠…) or with spaces/plus matches the stored `wa_id`; fewer than 3 digits never does a phone scan.
3. An older request answering last never renders (abort + latest-only), in every screen that uses the hook.
4. A query containing a phone number never reaches a log line unmasked (route errors, alerts).
5. Erasing a contact removes it from the name index in the same transaction (no ghost hits).

---

### Task A0 (done, PR #15): inbox stale-overwrite fix
`InboxSource.listConversations(filter, q, signal?)`, latest-only + abort + 150 ms debounce in `App.tsx`. Test `web/src/InboxSearch.test.tsx`.

### Task A1: name + phone index and one-call conversation search (track A)
**Files:** Modify `src/core/text-normalise.ts` (also fold Persian ۰-۹; add `phoneDigits(s): string`), `src/core/do-migrations.ts` (append `contacts_fts USING fts5(name)` keyed by contact rowid), `src/core/workspace-do.ts` (maintain `contacts_fts` on every write of `contacts.profile_name` incl. ingest, import, store link, erasure; rebuild in the same place `messages_fts` is rebuilt after restore), `src/core/api/contract.ts`, `src/routes/conversations.ts`. Test: `test/search-typeahead.test.ts`.
**Interfaces:**
- Produces: `normaliseText` (unchanged signature), `phoneDigits(s: string): string` (digits only, ٠-٩ and ۰-۹ → 0-9).
- Produces: DO `searchConversations(q: string, filter: ConversationFilter, limit: number): Promise<ConversationDto[]>`: union of conversations whose contact name matches (FTS prefix on every token), whose `wa_id` contains `phoneDigits(q)` when it has ≥ 3 digits, or that have a message matching `messages_fts`; newest activity first; ≤ limit.
- Produces: `GET /stores/:storeId/conversations?filter=&q=&limit=` returns `listConversationsResponse` (no cursor when `q` is set). Existing `/search` stays (message hits) for compatibility.
- [ ] Tests first: Review Focus 1, 2, 5; one-letter query; filter respected; another store's contacts never returned (tenant); `q` > 100 chars → 400.
- [ ] Implement; web `api.listConversations` uses the one call (drops the 10-page loop and the raw `includes`).

### Task A2: contacts list uses the same matching (track A)
`listContacts` `q`: name via `contacts_fts`, phone via `phoneDigits` (≥ 3 digits). Tests: Review Focus 1, 2 on `/contacts?q=`.

### Task A3: `q` on templates, campaigns and the operator lists (track A)
`GET /templates?q=` (name + body text, normalised), `GET /campaigns?q=` (name), operator lists that have >1 page of rows (`/operator/...` refund requests, InstaPay transfers, workspaces): `q` on their human fields only (names, references; never phone or e-mail unless already shown). Each with tenant/role tests unchanged and a match test.

### Task A4: per-workspace search rate limit + no raw query in logs (track A)
DO `searchAllowed(now): boolean` token bucket (20/s, burst 40) checked by every search route → `429 rate_limited`. A guard test that greps `src/routes` for logging `q`/`query` without `maskPhones`. Tests: 41st request in a burst is 429; refills.

### Task A5: bench (track A)
`test/perf.test.ts` `runIf(BENCH)`: 5,000 conversations / 20,000 contacts, 50 typeahead queries of 1-4 chars incl. Arabic + digits: p95 < 300 ms. Nightly workflow already runs benches.

### Task B1: `useTypeahead` + `SearchBox` (track B)
**Files:** Create `web/src/lib/useTypeahead.ts`, `web/src/components/SearchBox.tsx`, `web/src/lib/highlight.ts`; Modify `web/src/i18n.ts`. Tests `web/src/SearchBox.test.tsx`, `web/src/lib/highlight.test.ts`.
**Interfaces:**
- `useTypeahead<T>(fetcher: (q: string, signal: AbortSignal) => Promise<T[]>, opts?: { debounceMs?: number; minChars?: number }) => { query, setQuery, results: T[], status: 'idle' | 'loading' | 'done' | 'error' }`: 1st char, 150 ms, aborts the previous request, drops late answers.
- `highlight(text: string, query: string): { text: string; match: boolean }[]`: matches on `normaliseText` per character (tashkeel-insensitive), returns the ORIGINAL characters.
- `SearchBox` props: `label`, `query`, `onQuery`, `status`, `count`, `listId`, `activeId?`, `onKey?`: renders `role="combobox"` input (`aria-expanded`, `aria-controls`, `aria-autocomplete="list"`, `aria-activedescendant`), `dir="auto"`, and an `aria-live="polite"` status: loading / "مفيش نتايج لـ «…»" / "No results for “…”" / count.
- [ ] Tests first: abort-ordering (late answer never renders), debounce, ↑/↓/Home/End/Enter/Escape, `aria-activedescendant` follows, highlight on Arabic variants, RTL `dir`, both languages' copy.

### Task B2: inbox + contacts on the shared hook/box (track B)
Replace App's local logic and ContactsScreen's 250 ms debounce with `useTypeahead` + `SearchBox`; list items get `role="option"` ids for keyboard nav; matches highlighted in names and snippets.

### Task B3: new search boxes (track B, after A3)
CampaignForm template picker (combobox replaces the plain `<select>` when > 8 templates), Campaigns list, Shared templates panel, operator lists. Each: a11y + abort tests via the shared helpers.

## Order
A1 → A2 → A3 → A4 → A5 on track A; B1 → B2 (needs A1's endpoint) → B3 (needs A3) on track B. Each task = one PR through the gate; per-merge report to the controller.
