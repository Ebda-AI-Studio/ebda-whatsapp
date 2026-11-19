# Chat agent: product recommendations (2026-11-14)

Register row: "Product recommendations in the Chat agent" (Chat, was NOT BUILT). Store side: #742 (similar / bought-together engine, merchant switch).

## Goal
The WhatsApp agent suggests relevant products from the merchant's Ebda Store catalogue as WhatsApp product cards: similar items, complements, "you might also like" after an order, budget / occasion asks. No new AI calls: the model that already runs the agent turn decides to call one new tool.

## Finish line
- Must work: `recommend_products` tool (basis similar | complement | after_order | budget) returns cards of active, public, in-stock products of THAT store with Store prices; merchant toggle `recommendProducts` (default on) hides the tool; at most 3 sets per customer per 24 h, 1 per turn, no repeated product.
- Exercised: agent turns through the real webhook + scripted model (`test/agent-recommendations.test.ts`), Store bridge (Store PR: `wa-bridge-recommendations`, `wa-bridge-do-port-recommend`).
- Must NOT change: `search_catalog` / `show_products` behaviour, the 24 h window rule (the agent only runs inside it), reply guard (prices only from tool JSON), existing bridge methods.
- Done: both PRs green on touched tests; not merged; register row moves to OPEN-PR with the PR numbers.

## Design (reuse, no fork)
1. **Store bridge `getRecommendations(storeId, { seedIds | orderNumber+buyerKey(+phone), mode, limit, maxPriceMinor })`** (Store PR, stacked on #742). Calls `recommendationService.getProductRecommendations` (the engine, its merchant switch included) for up to 3 seed products, then RE-READS every candidate from the store: `storeId` + active + not deleted + `audience: public` + in stock, one cheapest in-stock variant per product, price from the store row (the engine list is cached 5 min, so only ids and order are used). Seeds resolve inside the store only. After-order seeds come from the buyer's own order (number AND key, same proof as `getOrderStatus`). Tenant = the bridge `storeId`, which Chat takes from the workspace Durable Object, never from the model.
2. **Chat tool `recommend_products`** (`src/core/ai/recommend.ts`, registered in `tools.ts`): `similar` / `complement` seed on a product id the model saw in a tool result; `after_order` derives the buyer key from the chat (like `order_status`) and uses the latest order unless the customer wrote a number; `budget` reuses the `search_catalog` path and filters by price and stock. Cards come from the existing `show_products` path (live re-read, catalogue ledger, one product message per turn, text fallback with links).
3. **Ration**: `agent_state` row `recs:<messageId>` = `{ at, ids }`, counted per customer through messages -> conversations -> contacts (same shape as the AI-turn cap), so an erased customer's rows are unlinkable and old ones are pruned at 2 days. 3 sets / 24 h, 1 / turn, ids already shown are skipped.
4. **Toggle**: `recommendProducts` in the agent settings contract (default true), a switch on the Agent screen (ar / en). Tone: the existing persona is in the system prompt; one prompt rule says when to recommend and to introduce cards in one short sentence.
5. Capability `agent.recommendations` (planned -> in-pr), help article section (en + ar) in `07-ai-agent`.

## Out of scope (stated, not hidden)
Proactive "you might also like" after an order OUTSIDE the 24 h window (needs an approved template and consent: separate row). Store-side ranking changes (#742 owns the engine).

## Tests (failing first)
Similar / complement / budget / after-order happy paths (Franco + Egyptian wording); out-of-stock, inactive, non-public, other-store seed (Store do-port test), model-supplied store id ignored, Store unavailable, toggle off, default on, ration (3/day, no repeats, one per turn), invalid arguments, forged buyer key (Store service test).
