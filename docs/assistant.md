# The Chat assistant (Smart Layer, phase A: read-only "how do I")

What it is: a side panel in the inbox app that answers "how do I ..." in Egyptian Arabic, English or Franco, grounded in `docs/help`, and shows the screen. It reads the merchant's own data through the normal routes with the merchant's own session (SL-CHAT-1). It changes nothing: no write tool is registered in this phase (`checkAdapterContract` fails the boot and the tests if one appears with a weaker policy than its capability).

## Code map
- `foundation/smart-layer/` vendored engine (never edit here). `src/core/smart-layer/` the adapter: `adapter.ts` (wiring), `tools/read.tools.ts` (free tools), `storage-do.ts` (journal in the WorkspaceDO, `sl_*` tables, the engine's storage contract runs against it in `test/smart-layer/storage-contract.test.ts`), `controls.ts`, `quota.ts`, `help-index.ts`, `handoff.ts`.
- `src/routes/assistant.ts` the three routes; `assistant/*.generated.json` the bundled registry and help corpus (`node scripts/build-help-corpus.mjs`; `test/smart-layer/assets.test.ts` fails when stale).
- `web/src/components/AssistantPanel.tsx` + `web/src/data/assistant.ts` the panel.

## Rollout switches (no deploy)
Per workspace: `PUT /api/v1/operator/workspaces/:id/assistant {"mode":"off|answer-only|suggest|act"}` (default off; a merchant can never change it). Platform: `PUT /api/v1/operator/assistant/flags` with `{"global":{"kill":true}}` (everything off), `{"global":{"mode":"answer-only"}}` (cap), `{"product":{"kill":true}}` (Chat only), `{"killedTools":["wallet_view"]}`, `{"global":{"shadow":true}}`. They live in D1 `platform_flags`, are read on every turn (never cached) and an unreadable switch fails closed. `GET /operator/assistant` shows them.

## Limits and data
150 free turns per workspace per rolling day (`sl_counters`); 10 per user per minute; 2,000 characters per message. Journal rows are masked, kept 90 days (the daily retention purge), and leave with the workspace. A handoff is the INFO alert `assistant_handoff` (masked transcript, journal ids).

## Known limits of this phase
Help grounding needs Vectorize and Workers AI bound; unbound, answers say "not covered" and offer support. The help index is built lazily on the first turn after a deploy (background) and again whenever the corpus hash changes.
