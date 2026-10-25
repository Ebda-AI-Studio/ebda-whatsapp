# Connectors (Phase 9.3)

A connector is a set of tools the AI agent (`docs/ai-agent.md`) can call to reach **the client's own systems**: a web service they run (the generic webhook connector) or their Odoo. The workspace owner configures them; the agent offers a connector's tools to the model only while the connector is enabled **and** the agent is on. Code: `src/core/connectors/**` (the core never names a product or client). Owner-only: staff get 403 on every connector route.

## Settings API (owner only)
`GET /stores/:storeId/connectors` · `PUT /stores/:storeId/connectors/:id` (full replace of the settings; `id` is `a-z0-9` with single hyphens, up to 16 chars) · `DELETE .../:id` · `POST .../:id/test`.
`PUT` body: `{ kind: 'webhook' | 'odoo', enabled, config, secret? }`. `secret` (webhook signing secret, 16+ chars; Odoo API key or password, 8+) is write-only: a string sets it, absent keeps it, it is never returned (answers carry `hasSecret`). It is stored AES-GCM encrypted with the workspace id as associated data (same helper and platform key `AGENT_SECRETS_KEY` as the merchant's own model key). Refusals are fixed codes: `invalid_url`, `secret_required` (enabling without a secret, or **changing the host without entering the secret again**), `kind_mismatch` (delete first), `too_many_connectors` (5 per workspace), `secrets_unavailable` (503).
`test` makes a harmless call and answers `{ ok, error?, detail? }` with a fixed code, never a response body: webhook = a signed `ping` event, Odoo = `common.version` then `authenticate`. One test per connector every 5 s (429 otherwise). It works on a disabled connector.

## Network rules (every call, not only when saving)
The same checks as a merchant's own model endpoint (`validBaseUrl`, shared code in `ai/provider.ts`): `https` on 443 only, no credentials/query/fragment in the URL, no IP literal in any notation, no internal-looking name (`localhost`, `*.internal`, `*.local`, ...), and **if the operator sets `AGENT_ALLOWED_HOSTS` the host must be on that list** (when unset, any public host passes the generic checks). All outbound calls go through one function, `connectorFetch` (`net.ts`): it re-checks the URL, follows **no redirect** (a 3xx is the error `redirect`), times out (8 s per request, 12 s per tool call in all), and reads at most **32 KB** of response (`too_large`). No automatic retries: the model is told the call failed and may decide to ask again; the same `idempotency-key` is sent every time for that call, so the client can deduplicate. DNS is not re-checked by us: a public name that resolves to a private address is not caught by these string checks (platform behaviour is the backstop, not tested here). Note `AGENT_ALLOWED_HOSTS` is one list for both model endpoints and connectors: once it is set, list every connector host in it too.

## What the model sees
Tool names are `<connectorId>__<tool>` (for example `crm__check_booking`), so a connector can never shadow a built-in tool. (A dot would read more naturally but OpenAI-compatible endpoints only accept `[a-zA-Z0-9_-]`.) Connector calls count against the agent's normal limits: at most 3 calls per round and 3 rounds per turn. The result handed to the model is JSON, at most about 3,000 characters (longer results are cut and marked `truncated`): `{"ok":true,"result":...}` or `{"ok":false,"error":"<code>","message"?}`. Error codes: `timeout`, `network`, `redirect`, `http_error`, `too_large`, `bad_response`, `blocked_host`, `invalid_arguments`, `unknown_tool`, `rejected` (the client said `ok:false`; its `message` is passed on, cut to 300 chars), `unavailable`, and for Odoo `auth_failed`, `access_denied`, `not_found`, `server_error`. The model never supplies a phone number or customer key; it never sees the customer's number.
A turn whose customer was erased or sent STOP makes no connector call (checked before and after every call). Nothing is logged about a call except the workspace, the tool name and the error code: never arguments, results, secrets, URLs or phone numbers.

## Generic webhook connector
Settings `config`: `{ url, tools: [ { name, description, params: [ { name, type: 'string'|'number'|'boolean'|'enum', description?, required?, maxLength?, values?, min?, max? } ] } ] }`. Limits: 10 tools, 10 parameters per tool, tool names `a-z0-9_` (no double underscore), string parameters up to 500 chars (default 200), enum up to 20 values. The model's arguments are validated against this before anything is sent; unknown keys are dropped.

Request: `POST <url>`, `content-type: application/json`, body
```json
{ "event": "tool_call", "tool": "check_booking", "args": { "reference": "AB12" }, "workspaceId": "...", "conversationId": 7, "buyerKey": "<hex>", "idempotencyKey": "conn:123:0", "at": "2026-11-02T16:30:00.000Z" }
```
Headers: `x-timestamp` (unix seconds), `x-signature: sha256=<hex>` where the hex is `HMAC-SHA256(secret, x-timestamp + "." + rawBody)`, and `idempotency-key` (same as `idempotencyKey`, stable for that tool call of that customer message). `buyerKey` is the suite's pseudonymous customer key (HMAC of the E.164 number); the number itself is never sent. Needs `SUITE_BUYER_KEY_SECRET` (a call without it fails with `unavailable`).
The `test` button sends `{ "event": "ping", "workspaceId", "at" }` signed the same way and expects `{ "ok": true }`.

Response: HTTP 2xx, JSON of at most 32 KB, exactly `{ "ok": boolean, "result"?: any, "message"?: string }`. `ok:false` becomes a `rejected` tool error.

Verifying the signature on the client (Node):
```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(rawBody /* Buffer, before any JSON parsing */, headers, secret) {
  const ts = headers['x-timestamp'];
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject stale calls
  const want = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const got = headers['x-signature'] ?? '';
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```
Deduplicate on `idempotency-key` for anything that changes state.

## Odoo connector
`config`: `{ url, database, login }` (url = the Odoo root, for example `https://erp.client.com`; JSON-RPC goes to `<url>/jsonrpc`); `secret`: an **API key** (Odoo 14+: user menu > Preferences > Account Security > New API Key; use it as the password, the login stays the same) or the password. Use a dedicated user with only the rights the tools need (contacts, sales quotations, calendar, stock read). The login (`common.authenticate`) is cached per connector settings version and cleared on an access-denied answer.
Tools (the customer is always the buyer of the conversation, resolved inside the call from their number; the model cannot name another customer):
- `find_or_create_partner { name? }`: finds `res.partner` whose `phone` equals the number in E.164 (`+201...`), the digits only, or `00`+digits; otherwise creates one (`phone` = E.164). Returns `{ partnerId, name, created }`.
- `create_sale_order { lines: [ { productId | code, qty } ] }` (1-20 lines): creates a **draft quotation** (`sale.order`, state draft; staff confirm it in Odoo) with `order_line` commands `(0, 0, {product_id, product_uom_qty})`, `client_order_ref` = the call's idempotency key (a repeat returns the existing quotation with `duplicate: true`). `code` is `product.product.default_code`. Returns `{ orderName, total, currency }`.
- `read_stock { ids?, codes? }` (up to 10): `product.product` `qty_available`. Returns `{ items: [ { productId, code, name, qtyAvailable } ] }`.
- `create_calendar_booking { name, start, end? | durationMinutes? }`: a `calendar.event` with the buyer as attendee (`partner_ids` `(6, 0, [id])`). `start`/`end` are ISO 8601 **with a UTC offset**; Odoo receives UTC `YYYY-MM-DD HH:MM:SS`. Default duration 60 min. A repeat of the same name + start + attendee returns `duplicate: true`.
Odoo faults map to: `AccessDenied` > `auth_failed`, `AccessError` > `access_denied`, `MissingError` > `not_found`, `ValidationError`/`UserError` > `rejected` (short Odoo message passed on), anything else > `server_error`. Odoo's debug trace is never read.
**NOT VERIFIED live:** no real Odoo was available. Field names follow Odoo's ORM reference and the external API documentation; requests were tested against a fake `/jsonrpc` only. A partner whose phone is stored in another format than E.164 is not matched (a second contact is created).

## Operating notes
- Backup: the `connectors` table (with the encrypted secrets) is in the nightly backup. After a restore into a deployment with a different `AGENT_SECRETS_KEY` the secrets cannot be opened: enter them again.
- Erasing a customer never touches connector settings (they are the workspace's, not the customer's). What the client's system stored on its side is the client's to erase.
- Migration v25 (`connectors`).
