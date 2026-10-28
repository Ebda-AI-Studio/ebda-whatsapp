# agent_model_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/ai/agent.ts (runBotTurnLocked) when the language model call for a bot turn throws. Fields: `workspace`, `error` (an error class name). The turn hands the conversation to a human with reason `provider_error`.
## Impact
The customer's conversation is handed off to staff instead of being answered by the bot. No money moves. A held AI credit is released if no model round completed.
## Check first
1. Search logs for `{"alert":"agent_model_failed"...}` and note `error`.
2. Check whether it is one workspace (a bad merchant model key, if the workspace uses its own) or all workspaces (a provider outage).
3. Read docs/ai-agent.md.
## Fix
1. Staff reply to the handed-off conversations from the inbox.
2. If every workspace is affected, wait for or escalate the provider outage; if one workspace, check its model key setting. Not documented in code: ask the engineer on call for the exact setting.
3. The system does not replay the failed turn. If the error repeats on every attempt you will also see `bot_turn_abandoned`.
## Verify it is resolved
New bot turns complete without handoff `provider_error` and the alert stops.
## Related
docs/ai-agent.md; bot_turn_abandoned
