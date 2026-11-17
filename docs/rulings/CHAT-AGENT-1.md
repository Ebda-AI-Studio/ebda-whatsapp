# Ruling CHAT-AGENT-1

**Decision:** The agent searches the catalogue through the Store's own search (`searchProducts`, ebda-store pr 757, Store ruling CHAT-AGENT-1), not by reading 500 variants. An empty answer from the Store is a real "we do not have it". Only when the Store cannot answer does the agent fall back (its own index, then the plain word match), and an empty fallback result is marked `uncertain` (and `incomplete` when the catalogue was larger than what was read) so the prompt makes the model say it will check, never "we don't have it". A shopper's budget travels as `maxPrice` (store currency) and becomes `maxPriceMinor` (piasters) at the bridge.

**Evidence:** audit 2026-11-14 D2 (silent 500-variant truncation = false negative) and rows 1-4; `test/chat-agent-search.test.ts` (8 cases incl. the 700-variant `incomplete` case); `test/store-bridge-contract.test.ts` replays the Store's pinned fixture `vectors/bridge-chat-context-v1.json`.

**Cost if wrong:** while the Store search is down every query uses the weaker fallback and its empty results read as "let me check" (a person may be asked more often); a Store search that ranks badly is now the agent's ranking too.
