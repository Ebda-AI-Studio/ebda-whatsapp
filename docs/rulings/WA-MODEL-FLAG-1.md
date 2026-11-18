# Ruling WA-MODEL-FLAG-1

**Decision (2026-11-17, controller):** Chat's platform model becomes a prepared, OFF flag so Ahmad's "yes" is one setting flip and instantly revertible. The default is unchanged: with the flag unset the system prompt, the model request and the reply are byte-identical to before.

- Flag: D1 `platform_flags` key `agent.model`, global (no per-workspace override: it would need the settings contract, DTO, UI and a per-owner audit reason, not cheap). Allow-list of exactly two ids: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (default when unset) and `@cf/openai/gpt-oss-120b`. Super admin only (`/operator/agent/model`), reason required, audited (`billing_audit.agent_model_set`).
- Behind the same flag, only for `gpt-oss-120b`: WhatsApp format strip before the reply guard, an English-ask-answered-in-Arabic corrective retry (one call, no extra credit, inside `MAX_MODEL_CALLS_PER_CREDIT`), and a stricter Egyptian prompt block.
- **Flip:** `PUT /api/v1/operator/agent/model {"model":"@cf/openai/gpt-oss-120b","reason":"<why>"}`. **Revert (one line):** `PUT /api/v1/operator/agent/model {"model":null,"reason":"<why>"}`. Takes effect on the next AI turn (read per turn, no cache).
- Before flipping set `AI_PRICE_INPUT_USD_PER_M_GPT_OSS` / `AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS` (Cloudflare pricing page), otherwise cost per credit is unknown and `ai_cost_over_threshold` cannot fire while the model is on.

**Evidence:** `test/agent-model-flag.test.ts` (allow-list 400, authorization, audit, default byte-identical, flip/flip-back, format table incl. Arabic/RTL/URLs, language retry bounds). Measured background (live Egyptian golden eval, 76 cases, Workers AI): default model 32/76; gpt-oss-120b 60, 59, 57 /76 with p95 about 3 s before these three mitigations.

**Cost if wrong:** if gpt-oss-120b regresses in production, the revert is one call and the next turn is back on the default model; customers in between may have seen up to one turn of a stray formatting or wording problem, and cost per credit is unmonitored until the two price vars are set.
