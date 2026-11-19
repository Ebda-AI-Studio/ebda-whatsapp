# ai_cost_per_1k_over_threshold (P1)
**Severity:** P1 look today
## What it means
The platform-paid AI cost per 1,000 AI turns passed 2 USD over one UTC day (at least 200 paid turns that day). Cost = input and output tokens x the configured per-million prices of the model that answered (`AI_PRICE_INPUT_USD_PER_M`, `AI_PRICE_OUTPUT_USD_PER_M`, and the `_GPT_OSS` pair for the flagged model); a turn on a merchant's own key or with no configured price adds no cost and is not counted in the divisor. Raised at most once per day. Fields: `paidTurns`, `usdPer1k`, `thresholdUsdPer1k`. **The unit is AI TURNS, not conversations** (one customer message that reached the model = one turn). The eval cost gate is per 1,000 conversation cases: the 78 golden cases contain 81 turns (1.04 turns per case), so the eval's 1.90-1.94 USD per 1k cases is about 1.83-1.87 USD per 1k turns, and the 2 USD/1k-turn threshold sits about 4% above the eval figure. A real conversation has more turns than an eval case: its cost is the per-turn figure times its turns (3 turns = three times). Ruling CHAT-EVAL-BAR-1c: the platform cost gate IS this unit cost (at most 2 USD per 1,000 AI turns); per-conversation economics are the per-workspace margin alert `ai_cost_over_threshold`, not this one.
## Impact
Margin, not service: customers are still answered.
## Check first
1. `GET /api/v1/operator/agent/health` (super admin): the day's `usdPer1kTurns` and `paidTurns`.
2. Prices: the vars above against Cloudflare's current Workers AI price for the model in use; a wrong price makes every turn look expensive (or free).
3. Token drivers: a long knowledge base or history raises input tokens; a longer completion ceiling or a reasoning model raises output tokens (`docs/analytics.md` section 3 has the per-workspace query).
## Fix
1. Wrong prices: correct the vars and redeploy.
2. A real cost increase after a model switch: revert the flag (`PUT /api/v1/operator/agent/model {"model": null, "reason": "..."}`), or lower the flagged completion budget (`FLAGGED_MAX_TOKENS` in `src/core/ai/agent.ts`) after measuring the trade-off with the live golden eval.
## Verify it is resolved
The next day's `usdPer1kTurns` is under 2 and the alert does not fire.
## Related
ai_cost_over_threshold (per-workspace margin alert); docs/billing.md ("AI credits"); docs/rulings/CHAT-EVAL-BAR-1.md.
