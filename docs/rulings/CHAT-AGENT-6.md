# Ruling CHAT-AGENT-6

**Decision (2026-11-14, independent review of ebda-store pr 757 I1 + ebda-whatsapp pr 79):** Chat's catalogue search reaches the Store's meaning leg and knows when it did not. Companion of the Store's CHAT-AGENT-6.

- `searchProducts` sends an opaque `searcher` (the hashed buyer key, `^[0-9a-f]{64}$`, never the phone) so the Store's default-deny query-embed gate has an identity; the Store namespaces it `wa-chat:<store>:<id>`, so Chat shares the Store's daily caps with the storefront and one shopper cannot drain more than the per-minute searcher cap.
- The answer is `{ items, degraded }` (adapter schema `searchResultSchema`, `degraded` defaults to false for an older Store). An EMPTY list with `degraded: true` is NOT the "real negative" of CHAT-AGENT-1: `search_catalog` falls through to the agent's own index and the word scan, and an empty result there is `uncertain` ("let me check"). Non-empty degraded answers are shown as they are.
- Contract: `vectors/bridge-chat-context-v2.json` replaces v1 (the Store's file, byte pinned in `test/vendored-artifacts.test.ts`).

**Evidence:** `test/chat-agent-search.test.ts` (degraded-empty is uncertain; degraded-with-hits is returned; the searcher is a 64-hex id and the phone never appears), `test/store-bridge-contract.test.ts` (v2 replay). Mutation check: dropping the `degraded` condition in `searchCatalog` turns the degraded-empty test red.

**Cost if wrong:** while the Store's embed budget is spent, Chat answers "let me check" (a handoff or a retry) for dialect queries instead of a confident "we don't have it"; the worst case is a few extra handoffs on a store at its daily cap.
