# Analytics: funnel, latency by stage, cost per workspace (T12, T26b, T32)

Everything below reads the Analytics Engine dataset `ebda_wa_usage` (binding `USAGE`) or the D1 ledger mirror. Nothing here contains a phone number, a name or a message text:
blobs are step / stage names, workspace ids and fixed vocabulary; doubles are counts, milliseconds and token counts.

Run a query (token with *Account Analytics: Read*; the account is the personal Cloudflare account):
```
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data-binary "<the SQL>"
```
Analytics Engine samples at high volume: always weight by `_sample_interval` (`sum(_sample_interval)` is a count, `quantileWeighted(0.95)(x, _sample_interval)` a p95). Data is kept 90 days.

## 1. The signup-to-paid funnel
Written by `src/core/funnel.ts` (`blob1 = 'funnel.<step>'`, `blob2 = workspace id`, `blob3 = detail` (a package id for `package_purchased`), `double1 = 1`). Steps in order:
`linked` (the Store linked the workspace) -> `number_connected` (Embedded Signup finished) -> `first_inbound` (first customer message) -> `first_ai_reply` (the agent answered) -> `package_purchased` (a paid package order was granted) -> `topup_credited` (a card top-up reached the wallet). `linked`, `first_inbound` and `first_ai_reply` are written once per workspace; the others can repeat, so every query below takes the FIRST time per workspace.

Workspaces that reached each step in the last 90 days:
```sql
SELECT blob1 AS step, count(DISTINCT blob2) AS workspaces
FROM ebda_wa_usage
WHERE blob1 LIKE 'funnel.%' AND timestamp > NOW() - INTERVAL '90' DAY
GROUP BY step ORDER BY workspaces DESC
```
Hours from linked to paid, per workspace (a workspace that never paid has no `paid_at`):
```sql
SELECT blob2 AS workspace,
       minIf(timestamp, blob1 = 'funnel.linked') AS linked_at,
       minIf(timestamp, blob1 = 'funnel.package_purchased') AS paid_at
FROM ebda_wa_usage
WHERE blob1 IN ('funnel.linked', 'funnel.package_purchased') AND timestamp > NOW() - INTERVAL '90' DAY
GROUP BY workspace
```
Weekly cohort conversion (linked -> paid): group the previous query by `toStartOfInterval(linked_at, INTERVAL '7' DAY)` in a wrapping `SELECT` and divide `countIf(paid_at > linked_at)` by `count()`.
D1 cross-check (always right, no sampling): `SELECT count(*) FROM workspaces`, `SELECT count(DISTINCT workspace_id) FROM workspace_subscriptions WHERE source = 'purchase'`, `SELECT count(DISTINCT workspace_id) FROM topups WHERE state = 'paid'`.

## 2. Latency p95 by pipeline stage
Written by `src/core/timing.ts` (`mark`): `blob1 = stage`, `blob2 = workspace id`, `double1` = ms since Meta's message timestamp, `double2` = ms since the webhook was received (either can be 0 when unknown). Stages: `webhook_ack`, `do_stored`, `enqueued`, `meta_accepted`, `unrouted`.
```sql
SELECT blob1 AS stage,
       sum(_sample_interval) AS points,
       quantileWeighted(0.50)(double2, _sample_interval) AS p50_ms_since_receipt,
       quantileWeighted(0.95)(double2, _sample_interval) AS p95_ms_since_receipt,
       quantileWeighted(0.95)(double1, _sample_interval) AS p95_ms_since_meta_ts
FROM ebda_wa_usage
WHERE blob1 IN ('webhook_ack', 'do_stored', 'enqueued', 'meta_accepted') AND double2 > 0 AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY stage ORDER BY p95_ms_since_receipt
```
One workspace: add `AND blob2 = '<workspace id>'`. The product budget is p95 < 500 ms inbound-to-reply; a stage whose p95 jumps shows where.

## 3. Cost per reply and per workspace
**One AI credit = one AI turn** (`docs/billing.md`). What a turn COSTS the platform is measured from the tokens each turn writes (`src/core/timing.ts`, `markAiTurn`): `blob1 = 'ai_turn'`, `blob2 = workspace id`, `blob3 = outcome` (`reply`, `order`, `handoff:<reason>`, `error`), `double1 = input tokens`, `double2 = output tokens`, `double3 = model rounds`, `double4 = milliseconds`, `double5 = credits charged` (0 for a workspace with its own model key).
```sql
SELECT blob2 AS workspace,
       sum(_sample_interval) AS turns,
       sum(double1 * _sample_interval) AS input_tokens,
       sum(double2 * _sample_interval) AS output_tokens,
       sum(double5 * _sample_interval) AS credits_charged,
       quantileWeighted(0.95)(double4, _sample_interval) AS p95_turn_ms
FROM ebda_wa_usage
WHERE blob1 = 'ai_turn' AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY workspace ORDER BY output_tokens DESC
```
Platform cost per turn = `(input_tokens * input_price + output_tokens * output_price) / turns`, with the model's current per-token prices from Cloudflare's Workers AI pricing page (the prices are NOT stored here: look them up on the day you run the query). Compare with the credit's price: package price / package credits (`starter` 69000 minor / 300 credits is 2.30 EGP per credit; a package also pays for the features, so this is an upper bound on what a credit is worth).

Meta cost and wallet movement per workspace, month by month, from the D1 ledger mirror (exact, no sampling; amounts are EGP minor units, charges negative):
```sql
SELECT workspace_id,
       strftime('%Y-%m', at / 1000, 'unixepoch') AS month,
       -sum(CASE WHEN kind = 'meta_charge' THEN amount ELSE 0 END) AS meta_charged_minor,
       sum(CASE WHEN kind = 'topup' THEN amount ELSE 0 END) AS topups_minor,
       count(CASE WHEN kind = 'meta_charge' THEN 1 END) AS billed_messages
FROM ledger_mirror
WHERE ledger = 'wallet' AND at >= :since_ms
GROUP BY workspace_id, month ORDER BY meta_charged_minor DESC
```
`npx wrangler d1 execute ebda-wa-platform --remote --command "<the SQL with the date inlined>"`. The workspace's own view of the same week is the digest (`GET /api/v1/stores/:storeId/digest`).
