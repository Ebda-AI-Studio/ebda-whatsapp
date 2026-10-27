# bot_turn_abandoned (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/workspace-do.ts (scheduled task `bot_turn`) when the AI agent turn for a customer message failed on every attempt (BOT_TURN_MAX_ATTEMPTS = 6) and was dropped. Fields: `workspace`, `attempts`, `error` (an error class name).
## Impact
One customer message got no bot reply. No money moves. The customer is not told; they can write again. Repeated alerts mean the AI feature is broken for that workspace.
## Check first
1. Search logs for `{"alert":"bot_turn_abandoned"...}` and note `error`.
2. Look for `agent_model_failed` in the same workspace and time window (model provider failures).
3. Read docs/ai-agent.md.
## Fix
1. The system gives up after the final attempt and does not retry again. A staff member can answer the customer from the inbox.
2. Fix the cause named in `error`. Not documented in code: ask the engineer on call.
## Verify it is resolved
New customer messages in that workspace get a bot reply or a handoff, and the alert stops.
## Related
docs/ai-agent.md; agent_model_failed
