# Ruling CHAT-SHARE-1

**Decision (2026-11-10):** wa.ebda.app carries its own share preview and lets the visit-count script run; four things are deliberately left as they are.

1. **Share preview.** The suite brand pack has a `share` block (`web/brands/ebda/brand.ts`); `web/brands/share-head.ts` writes description, canonical, Open Graph, the large card and one JSON-LD block into the built page (`%SHARE_HEAD%` in `web/index.html`). It is written at build time because a link preview never runs the page's script. A brand with no `share` block gets no tags (the demo build is checked for that).
2. **Preview image.** `web/brands/ebda/public/brand/og-chat.png` (1200 x 630) is the sign-in lockup on night: gold symbol, ابدأ ستوديو, ابدأ شات, in the page's own typeface. It was rendered once from an HTML page with a headless browser; the browser is not a dependency of this repo, so the script is not committed. To change the image, redraw it at the same size and replace the file.
3. **Visit-count script.** `script-src` gains `https://static.cloudflareinsights.com` and nothing else. Measured on production: the tag the edge adds carries a `version`, and with a version the script reports to this origin (`/cdn-cgi/rum`), which `connect-src 'self'` already allows.
4. **Left as is: the 401 on `/token` for a signed-out visitor.** That request is how the page learns nobody is signed in (CHAT-SIGNIN-ENTRY-1); the browser logs every failed request, and the page shows the sign-in entry, not an error.
5. **Left as is: the demo brand.** Its `_headers` and page are a client's own zone; it gets neither the analytics host nor any share tag.
6. **Left as is: the shared "nothing here" page** (`vendor/studio/studio-pages`). Its own policy still refuses the visit-count script. That file is vendored; the change belongs in the Store's shared pages, then a sync here.

**Also fixed here:** `web/src/data/auth.ts` read the access token from the top of the `/token` answer, while the identity service wraps it as `{ success, data }`. Every signed-in person got the "could not reach" page (measured on production 2026-11-10). `readTokenBody` reads both shapes and refuses a 200 with no usable token.

**Evidence:** `test/assets-config.test.ts`, `test/white-label.test.ts` (both brands are built and the built page is read), `web/src/data/auth.test.ts`. The built suite page was served locally with its real policy: the visit-count script loaded, a control script from another host was refused, and the JSON-LD block raised no policy report.

**Cost if wrong:** if the edge ever sends the tag without a version, visit counts stop (the report would go to another host that `connect-src` refuses) while everything else keeps working; a wrong sentence or image in the preview is a one-file change and a deploy.
