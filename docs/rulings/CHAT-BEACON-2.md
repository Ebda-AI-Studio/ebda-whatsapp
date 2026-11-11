# Ruling CHAT-BEACON-2

**Decision (2026-11-10):** every HTML page this Worker serves on wa.ebda.app names the visit-count script host in `script-src`, and nothing else is widened. Supersedes item 6 of Ruling CHAT-SHARE-1.

1. **The "nothing here" 404.** `src/addons/ebda/not-found.ts` sends `NOT_FOUND_HEADERS`: the vendored `STUDIO_PAGE_HEADERS` with `https://static.cloudflareinsights.com` appended to `script-src`. `vendor/studio/` stays the Store's file byte for byte (sha-pinned in `test/vendored-artifacts.test.ts`); the override is a no-op once the Store's `packages/shared/src/studio-pages` names the host and is re-vendored. The Store's own hosts that send `STUDIO_PAGE_HEADERS` (accounts, status, studio pages) need the same host.
2. **The Meta data-deletion pages** (`/meta/data-deletion`, `/meta/data-deletion/status`, HTML only) send `default-src 'none'; script-src https://static.cloudflareinsights.com; frame-ancestors 'none'` (`DELETION_PAGE_CSP` in `src/index.ts`). Found by the sweep: the edge adds the tag there too.
3. **Left as is: `connect-src`.** Neither page allows `'self'`, and the script reports to this origin (`/cdn-cgi/rum`), so the script now loads without a console error but those visits are still not counted. Adding `connect-src 'self'` is a separate one-line decision.

**Evidence (2026-11-10, production):** `curl -H 'accept: text/html' https://wa.ebda.app/zz-nope` and `/meta/data-deletion` both carry `<script ... src="https://static.cloudflareinsights.com/beacon.min.js/...">` while their policies named no such host. Tests: `test/studio-404.test.ts`, `test/meta-data-deletion.test.ts` (both fail without the change).

**Cost if wrong:** a script from that one host can run on two static pages that hold no personal data; 404 and deletion-page visits stay uncounted until `connect-src 'self'` is decided.
