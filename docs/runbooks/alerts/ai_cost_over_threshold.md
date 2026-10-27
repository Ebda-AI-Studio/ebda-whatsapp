# ai_cost_over_threshold (P1)
**Severity:** P1 look today
## What it means
`recordTurnCost` in `src/core/ai/cost.ts` keeps a rolling average of what one AI credit costs the platform in a workspace (tokens x the model's per-million prices x the workspace's FX). After at least 10 turns, when the average passes half the plan's break-even per credit (Starter 1.00, Growth 0.45, Pro 0.33 EGP), it raises this alert at most once a day. Fields: `workspace`, `package`, `avgEgpMicros`, `thresholdEgpMicros` (EGP micros: 1,000,000 = 1 EGP).
## Impact
Margin, not service: the workspace keeps working. A plan whose credits cost more than half their price is approaching a loss at full use.
## Check first
1. Search logs for `{"alert":"ai_cost_over_threshold"...}`; note the workspace and package.
2. Run the cost-per-workspace query in `docs/analytics.md` section 3 for that workspace: tokens per turn, turns, p95 turn time. A sudden jump in input tokens usually means a long knowledge base or history; in output tokens, a persona that asks for long replies or a model change.
3. Check the prices: `AI_PRICE_INPUT_USD_PER_M` and `AI_PRICE_OUTPUT_USD_PER_M` in `wrangler.jsonc` against Cloudflare's current Workers AI price for the model in use (`AGENT_MODEL`); a wrong price makes every plan look expensive.
## Fix
1. If the prices were wrong, correct the vars and redeploy; the average recovers within about 10 turns.
2. If the workspace really is expensive: Not documented in code: decide with Ahmad between a cheaper default model, a shorter prompt, or a package change; the merchant is never charged more per credit automatically.
## Verify it is resolved
The workspace's average cost per credit in `docs/analytics.md` section 3 is under the plan threshold and the alert stops.
## Related
docs/billing.md ("AI credits"); docs/analytics.md; ai_credits_low (merchant-side low balance, INFO).
