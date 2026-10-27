# unhandled_error (P1)
**Severity:** P1 look today
## What it means
A Hono route threw and `app.onError` in `src/index.ts` caught it. The caller got `500 {"error":"internal"}` and Sentry captured the exception. Fields: `workspace` (when the route has a `storeId`), `route`, `method`, `error` (error class only).
## Impact
One request type failed for a merchant or the platform. Whether money or a message was affected depends on the route.
## Check first
1. Search logs for `{"alert":"unhandled_error"...}`; note `route`, `method`, `error`.
2. Find the event in Sentry by route and time.
3. If `route` is `/kashier/webhook` or a billing route, also check the money alerts of the same minute.
4. Read docs/runbooks/alerts.md, section unhandled_error.
## Fix
1. A client retry usually repeats the request; the system does not retry by itself, except that Kashier and Meta redeliver webhooks that answered 5xx.
2. If it repeats, treat it as a bug: ask the engineer on call. Consider docs/runbooks/rollback.md if it began after a deploy.
## Verify it is resolved
No new `unhandled_error` for that `route`, and the route answers normally.
## Related
docs/runbooks/alerts.md; docs/runbooks/rollback.md
