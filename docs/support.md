# Support: intake, escalation, and the operator's tools (T33, T34, T35)

The support contact is **email**, the brand's `supportEmail`: `ahlan@ebda.app` (`web/brands/ebda/brand.ts`, pinned to the Store's brand constant in `vendor/brand/store-support-email.json`, Ruling WA-SUPPORT-1). It appears in the app (failed payment lines), in the help articles and in the terms. A white-label brand with `supportEmail: null` shows its own contact instead; this page is about the suite brand.

## 1. Intake (T33)
**One mailbox, one thread per problem.** A merchant writes to the support address; whoever picks it up answers from that thread and keeps it until it is closed.

What a good request contains (the first reply asks for whatever is missing, in Egyptian Arabic, one sentence per item):
1. The store name and the email the owner signs in with (this finds the workspace; never ask for a password).
2. What they were doing, what they expected, what happened, and when (date and time in Cairo time).
3. For a payment: the order reference shown on screen or in the Kashier / InstaPay receipt. For a message: the first four digits and the last four digits of the customer's number, not the whole number.
4. A screenshot is welcome only if it hides customers' names and numbers.

**Never** ask for or accept in the thread: a password, a Meta token, a card number, a full customer phone number, an export of chats. If a merchant sends one, say so, ask them to delete it from their sent mail, and do not copy it into any ticket, note or chat.

**Priority**
| P | Meaning | Target for the first human reply (Ruling SUPPORT-SLA-1, default; Ahmad may change it) |
|---|---|---|
| P1 | cannot send or receive at all, money looks wrong, the number was blocked or flagged | the same business day (Cairo) |
| P2 | one feature does not work, a campaign is stuck, a template is rejected | the next business day |
| P3 | a question, a request, feedback | within three business days |
Cost if wrong: a target that is too tight is missed and trains merchants to expect it; too loose and a P1 waits. The numbers are a starting point to be changed after the first month of real mail.

**Macros** (the replies that are the same every time) live with the help articles in `docs/help/{ar,en}`; a request that a guide answers gets the guide's link, not a new explanation.

## 2. Where to look first (the operator console, `/api/v1/operator`)
| Question | Look at |
|---|---|
| Is the workspace suspended, its integrations revoked, evicted from the shared number? | `GET /workspaces/:workspaceId/ops` (console: Kill switch tab) |
| What does the merchant see? | **View as merchant** (below) |
| Money: balance, held, ledger | `GET /workspaces/:workspaceId/wallet`; adjustments `POST /workspaces/:workspaceId/adjustments` (two operators) |
| Package and period | `PUT /workspaces/:workspaceId/subscription` (reason required, audited) |
| A refund request | `GET /refund-requests`, `POST /refund-requests/:id/decision`, `docs/billing.md` |
| InstaPay proof | `GET /instapay`, `.../proof-link`, `POST .../confirm` or `.../reject` |
| Something alerted | the alert's runbook: `docs/runbooks/alerts/<name>.md` (the Telegram message links it) |
| What changed in billing and who changed it | `GET /change-log` |

## 3. The merchant's escalation path (T34)
1. **Support mailbox** (above). First reply within the target. Most requests end here with a guide link or a short answer.
2. **Engineer on call** (Ahmad, until there is a second person). The support person hands over by forwarding the thread with: workspace id, what was checked (alert, runbook, view-as), and the merchant's own words. The engineer works from the alert runbooks and does NOT ask the merchant to repeat what is already in the thread.
3. **Ahmad decides** anything that is money outside the documented operator actions (a refund that the flow refuses, a credit, a plan exception), anything legal (a data request, a complaint, a Meta account problem), and any P1 that is still open after one business day. Ruling SUPPORT-ESC-1: a thread with no reply by its target is re-opened by the next person who sees it and is handed to level 2 at target + 1 business day. Cost if wrong: an unanswered P1 can sit for a day before anyone with the rights to act sees it; the alerts (`docs/runbooks/alerts.md`) are what catch outages without waiting for mail.
4. **Data-protection requests** from a merchant's customer (erase, export) go through the merchant: the owner erases a contact in the app (`DELETE /contacts/:waId`); Meta's data-deletion URL has its own flow (W2-LEGAL). Privacy and legal mail goes to level 3 on the day.
5. **Abuse or a quality problem** (a number flagged, a campaign that looks like spam): suspend or pause first with the kill switch (`POST /workspaces/:workspaceId/suspend` or `.../campaigns/pause`), then write to the merchant. Resuming is a level 3 decision.

## 4. View as merchant (T35)
An operator can open a merchant's account to see what they see, **read-only and audited**.
- **How:** in the operator console, "View a merchant's account": type the workspace id, "Open read-only". The page asks for a reason (at least 10 characters) and opens the merchant app for that workspace, marked by a bar at the top. Under the hood every request carries `X-View-As-Merchant: 1` and `X-View-As-Reason: <reason>` and the operator's own token.
- **Read-only:** any write (send, edit, erase, top-up, even toggling the weekly summary) answers `403 view_as_read_only`; a live socket is refused. The view has no realtime updates: reload the page.
- **Audited:** each request, refused ones included, is written to D1 `operator_view_log` (who, which workspace, method, the ROUTED pattern, e.g. `/stores/:storeId/contacts/:waId/orders`, plus the concrete route params as keyed hashes in `params` (a JSON of name -> HMAC under ERASURE_HMAC_KEY; the waId hash is the erasure subject hash, so one person has one hash whatever spelling was typed), time; the operator's typed reason goes to the deletable `audit_reasons` and the row carries only `reason_id`, AUDIT-REASONS-1) BEFORE it is served; if the row cannot be written the request is refused (`503 view_as_audit_unavailable`). The log holds no body, no query string, no raw path and no phone number (final review I4; the old regex mask missed `%2B20...`, Arabic-Indic digits and `20-100-...`). It is append-only (triggers). Read it with `GET /operator/view-log?workspaceId=<id>` (the reason is joined in while the workspace exists; after its deletion the row stays, with the opaque id and no text). The audit names WHICH record was viewed (the same hash on every view of the same record) but never a phone. A write with the view-as header answers `view_as_read_only` (and is logged) before any operator-route check.
- **Only operators:** a merchant who sends the header gets `403`. A platform operator who is NOT a member of the store must use the header and a reason on EVERY store route, reads included: without them the read is `403 view_as_required` and nothing is served or logged (final review I3; a member is unaffected; writes keep `403 operator_route_required`, use the `/operator/...` routes).
- Tell the merchant when you looked and why, in the thread. They can ask for the log of their own workspace.
- INTEGRATION FLAG: `operator_view_log` (D1 migration 0025; `reason_id` added by 0027) is separate from the workspace `audit_log` of W2-ERASE (T8). When that lands, either keep this table as the operator-access trail or fold its rows into `audit_log`; the middleware writes through one statement in `src/core/identity/middleware.ts`.
