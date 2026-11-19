# agent_reply_blocked_rate (P1)
**Severity:** P1 look today (watch closely for 24 h after a model switch)
## What it means
The reply guard (`src/core/ai/reply-guard.ts`) refused more than 3% of the AI turns of one hour (at least 20 turns in the hour): the model started writing a link, price or promise nobody vouched for. Each refusal handed that customer to a person, nothing wrong reached a customer. Raised at most once per hour. Fields: `turns`, `blocked`, `ratePct`, `model` (`default` or the flagged model). Counters: D1 `agent_health` (AGENT-HEALTH-1).
## Impact
Service quality, not money: more handoffs than normal. If the cause is a model regression, the guard is the only thing standing between it and customers, so do not loosen the guard.
## Check first
1. `GET /api/v1/operator/agent/health` (super admin): the current hour's `turns`, `blocked`, `blockedRatePct`, and the day's cost.
2. Logs: `agent_reply_blocked` lines carry `why` (`url` / `price` / `promise` / `leak`) and `shape`, never the text. One `why` dominating = one failure class (e.g. `url` = replies cut mid-link: check the completion budget; `price` = a hallucinated amount).
3. Did the agent model flag change recently? `GET /api/v1/operator/agent/model`.
## Fix
1. After a model switch with the rate staying above 3% for the hour: revert the flag (`PUT /api/v1/operator/agent/model {"model": null, "reason": "..."}`), then run the live golden eval on the model before trying again (docs/ai-agent.md "Golden eval").
2. A single dominant `why`: fix the prompt/budget for that class; never widen the guard to make the alert stop.
## Verify it is resolved
`GET /api/v1/operator/agent/health` shows `blockedRatePct` back under 3 for a full hour.
## Related
agent_model_failed; docs/rulings/CHAT-EVAL-BAR-1.md (1b); docs/ai-agent.md.
