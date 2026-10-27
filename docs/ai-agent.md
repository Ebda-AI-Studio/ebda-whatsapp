# AI agent (Phase 5)

An optional agent answers customers' free-text questions on WhatsApp, next to the ordering bot of the Store link (`docs/store-link.md`). It is off until the owner switches it on. Code: `src/core/ai/**` (the Egyptian-Arabic persona and fixed phrases live in `src/addons/ebda/agent-copy.ts`; the core never names the product).

## One router, never two bots
Every inbound message becomes one `bot_turn` task. Inside the customer's turn lock (`serialisedTurn`) `src/core/ai/router.ts` decides:

1. A person has the conversation (`agent_handoffs.until_at` in the future): silence, for both bots.
2. Agent on and the words ask for a person (patterns in the addon, matched on `normaliseText`): handoff, no model call, no credit. Works mid-order too.
3. Ordering bot when the customer is mid-order (a session that is not `idle` and younger than 30 min), tapped a button/list, sent a Meta cart or a picture, or used an ordering keyword (menu, my orders, language words).
4. Otherwise the agent, if enabled. Voice notes and files get one "text only" note.

With the agent off, behaviour is exactly Phase 4. With no Store bound, the agent works alone (without the catalog/order tools). While the agent or the ordering bot is on, the generic auto reply is suppressed.

## A turn (`agent.ts`)
Same rules as the ordering bot: the customer must still be there (not erased, no STOP sent after the message) after every await before a write; replies only inside the 24 h window; sent directly, 150 ms apart (`botSendGapMs`); a replayed task does not call the model again (`agent_turns` is written in the same transaction as the reply rows, keys `agent:<messageId>:<n>`).

- Prompt: persona (merchant's or the default), language rule (`ar` default, `en`, `auto`), rules, tool names, up to 4 knowledge chunks, the last 8 messages.
- Quick ack (`copy.t.ack`) before the model only when a reply is expected to exceed 2 s: the workspace's average answer time (`agent_state.latency_ewma_ms`, alpha 0.3) is above `slowMs` (2000), or a turn already took 2 s when it is about to run tools.
- At most 3 tool rounds (3 calls per round); the 4th model call is offered no tools. Still asking for tools, empty output, leaked JSON/tool markup, `<think>` only, or a model error (one retry for retryable errors) means a handoff, never silence and never raw model output.
- Tools: `search_catalog` (semantic candidates from the vector index, then price/stock/link read from the Store now; fallback: read up to 500 variants and rank by matching words), `order_status` (Store `getOrderStatus` / `listCustomerOrders`; the customer key is derived from the conversation, the model never supplies a phone or key), `start_order` (opens the ordering menu: runs the ordering turn with a restart), `handoff_to_human`. Tool arguments are validated with Zod; errors go back to the model as `{"error": "..."}`.

Connectors (Phase 9.3, `docs/connectors.md`) add the tools of the workspace's enabled webhook/Odoo connectors, named `<connector>__<tool>`; they count in the same 3x3 call cap and are never called for a customer who is gone.

Replay rules: the 24 h window is checked first (a late retried turn sends nothing, not even the text-only note). A retried turn whose credit was already charged never calls the model again; it redelivers whatever replies it stored (none = the customer writes again).

## Handoff
`handoff_to_human`, a words match, no credits, no usable model, model failure or unusable output: the customer gets `copy.t.handoffAck`, the conversation is tagged `needs_human` (inbox lights up through the usual `conversation.updated` event, which carries the tags) and the bot is silent for `handoffMinutes` (default 120). A staff reply (API, or an echo from the Business app) or assigning the conversation to a person clears the tag and restarts the silence for a fresh window counted from that reply; with no open handoff the reply opens one (reason `staff`, no badge), so the agent is silent "until staff replies" and then for the window. After the window the bot resumes and the tag is cleared on the next message. The reason is stored as a code (`asked | model | no_credits | misconfigured | provider_error | bad_output | no_answer | staff`), never free text.

## AI credits (`credits.ts`, Phase 7 design)
`credit_ledger`: append-only (SQLite triggers refuse UPDATE/DELETE), unique `ref`, `balance_after`; `credit_holds` reserve a credit before the model is called (`ai:<messageId>`) and are settled (charged) or released after; `available = balance - held`, read and written in one synchronous transaction, so concurrent messages cannot overdraw. A hold's TTL is 10 min and each model round refreshes it (heartbeat); settling a lapsed hold re-checks availability and posts nothing if the credit went elsewhere (`ai_overdraw_refused` alert). One credit per agent turn (up to 4 model calls). Workspaces with their own model key are never debited. Monthly grant `grant:<period_start>:<package>`, upgrade tops up the difference, `expire:<period_start>` removes unused granted credits (purchased ones roll over). DO methods for Phase 7: `grantAiCredits`, `upgradeAiCredits`, `expireAiCredits`, `postAiCredits` (adjustments need actor + note), `aiCredits`. Grants now arrive with the subscription (`entitlements`, see `docs/billing.md`); a workspace with no grant has 0 credits, so a Workers-AI agent hands every customer over. Every credit row is also written to `ledger_outbox` in the same transaction and mirrored to D1 `ledger_mirror` (ledger `credit`). `GET /wallet` returns the credit balance. No phone or name is stored in these tables; erasure never touches them. `credit_ledger` and `agent_state` are in the backup.

## Models
`LlmProvider` (`provider.ts`): `WorkersAiProvider` (`env.AI`, model `AGENT_MODEL` var, default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) and `OpenAiCompatibleProvider` (bring your own key; base URL + key from the workspace). The key is AES-GCM encrypted (`secrets.ts`, platform secret `AGENT_SECRETS_KEY` = base64 of 32 bytes, workspace id as associated data), write-only (the API returns `hasApiKey`). Base URLs: https/443 only, exact host from the built-in list (OpenAI, Google, Anthropic, OpenRouter, Groq, Together, Mistral, DeepSeek, xAI) plus the operator's `AGENT_ALLOWED_HOSTS`; no userinfo/query, no IP literal in any notation, no internal-looking name; redirects are never followed; changing the origin requires a new key in the same request. Providers never log prompts, replies or keys; failures are classes (`LlmError`).
**NOT VERIFIED live:** the Workers AI request/response shape for tool calls (OpenAI-style messages and `tools`; both `choices[0].message` and `{response, tool_calls}` answers are parsed) was built from documentation and tested against fakes only; no remote model call was made.

## Knowledge base and catalog index
FAQ text (`faqText`, up to 20,000 chars) is chunked (paragraphs, then sentences, ~600 chars, at most 60), embedded with `@cf/baai/bge-m3` (1024 dims, cosine) and upserted to Vectorize namespace `<workspace>:kb`. A changed text is a new version: the old one keeps answering until every chunk of the new one is embedded, then it is dropped (rows and vectors). Retrieval embeds the customer's message, keeps matches with score >= 0.35 and puts the top 4 into the system prompt. The catalog is embedded the same way (namespace `<workspace>:catalog`, one vector per variant, re-embedded only when its text hash changes, nightly 04:00 Africa/Cairo and after catalog events, only while the agent is on). Vectorize ids are 32-hex hashes (the limit is 64 bytes). Everything degrades to "no knowledge base" / plain catalog search when the index or embedder is not bound or fails.
**Turning it on:** create the index and uncomment the binding in `wrangler.jsonc`: `npx wrangler vectorize create ebda-wa-kb --dimensions=1024 --metric=cosine`. Vectorize writes are asynchronous (a vector can take seconds to be searchable). After a backup restore the FAQ chunks are gone (derived data): save the FAQ again.

## Settings API (owner only; staff get 403)
`GET /stores/:storeId/agent` -> `agentSettingsDto`; `PUT /stores/:storeId/agent` (partial merge, `agentSettingsUpdate`): `enabled, persona (<=1000), language, handoffMinutes (5-1440), faqText, provider, model, baseUrl, apiKey` (string = set, `null` = remove, absent = keep; never returned). Answers add `hasApiKey`, `credits` (available) and `knowledgeReady`. Refusals are fixed codes: `invalid_base_url, model_required, api_key_required, model_not_allowed` (400), `secrets_unavailable` (503). Messages gain an optional `author: 'agent' | 'bot' | 'staff'` (set only when known).

## DO migrations added
v17 `agent_state` · v18 `messages.author`, `agent_turns`, `agent_handoffs` · v19 `credit_ledger`, `credit_holds` (+ triggers) · v20 `kb_chunks`, `catalog_vectors` · v25 `connectors` (Phase 9.3). Scheduler kinds: `kb_index`, `catalog_embed`.

## Eval
`test/ai-eval.test.ts` ports the old product's intent eval: its intents become the tool an utterance must lead to, and its output-shape checks (valid intent, required field, confident answer has a reply, no leaked JSON) become guards. 30 cases (12 golden tool/reply paths, 8 handoff phrasings, a model handoff, 9 malformed-output cases) against a scripted fake model: **pass rate 30/30 (100%)**. This measures the harness (routing, validation, guards, handoff, credits), not a live model's judgement; a live golden run was not done.

## Secrets and settings to set before use
`AGENT_SECRETS_KEY` (secret, only for bring-your-own-key), optional `AGENT_MODEL`, `AGENT_ALLOWED_HOSTS` (also the allowlist for connector hosts once set); the Vectorize index above. Customer message text is sent to the configured model (Workers AI on this account, or the merchant's own provider).

## Abuse controls (W2-ABUSE: F1, F2, B6, M-069, M-177)
- **Masking before the model (B6).** `mask.ts`: phones, card-like numbers (13 to 19 digits) and e-mails in the customer's text and in the history are replaced by `[phone]`, `[card]`, `[email]` before the request is built. The stored message is untouched. Connector error text gets the same mask (M-177, `toolContent`).
- **Instruction boundary (F2).** Customer text is sent inside `<customer_message>` tags (a fake tag typed by the customer is stripped); the core appends `BOUNDARY` to the product's system prompt: customer text, tool results and knowledge are data, never instructions.
- **Tool budget.** At most 6 tool calls (built-in and connector together) are executed per turn (`MAX_TOOL_CALLS_PER_TURN`); a call past it is answered `tool_budget` and does nothing. Rounds and calls per round stay 3 and 3.
- **Reply guard (`reply-guard.ts`).** Before a reply is stored it is checked against the TRUSTED texts of the turn (persona, FAQ, knowledge chunks, tool results; never customer text): (1) every link host must appear there, (2) every amount next to a currency word must be a number that appears there, (3) a refund / discount / free-shipping / guarantee promise needs the same promise class in those texts, (4) it must not recite 8 consecutive words of the rules. A refused reply becomes a handoff (`guarded`, INFO alert `agent_reply_blocked`). Cost: a reply that restates a sum the model computed itself is refused too.
- **Turn cap (F1).** One customer gets `agentConfig().turnsPerDay` (30) AI turns in a rolling 24 h; the next message is handed to a person (`turn_cap`, INFO alert `agent_turn_cap`) without calling the model or holding a credit.
- **Injection eval.** `test/ai-injection-eval.test.ts`: 21 fixed cases where the scripted model obeys the attacker; it runs in `npm test` and CI like any test.

Ruling WA-GUARD-PROMISE-1 - a promise class is "configured" when the merchant's own persona, FAQ, knowledge or a tool result of this turn mentions the same class; there is no separate promises setting. Evidence: no settings schema, UI or migration is needed and the merchant already controls those texts. Cost if wrong: a merchant who wants refunds promised must write the refund policy in the FAQ, otherwise those replies go to a person.
