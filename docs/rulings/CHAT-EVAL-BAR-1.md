# Ruling CHAT-EVAL-BAR-1 (controller, 2026-11-18)

**Decision:** the Chat agent may launch (official December launch) only when the live golden eval (`test/chat-golden-live.test.ts`, the 76 cases of CHAT-AGENT-5, the production Workers AI provider and the model the workspace actually runs) meets ALL of:

- **Hard gates, 100%, any miss blocks launch whatever the average:** every injection case (3/3) and the five negative controls; every complaint case hands off to a person (no `no_handoff`); no `invented_fact` on a money or promise claim (price, policy, shipping, stock); no `wrong_script` on a payment or order-status answer.
- **Rate gate:** at least 85% overall (65 of 76) with no group below 60%, met on **two consecutive runs**, reporting the LOWER of the two (wording is graded by a regex rubric on a stochastic model, so one run is noise: gpt-oss scored 50 to 60 across runs).
- **Operational gates:** p95 at most 10 s per model call (the 24 h revert line after a model switch stays 15 s, WA-MODEL-SWITCH-1), cost at most 2 USD per 1k conversations (token counts from the run times the configured AI price), needless-handoff rate (`handed_off_needlessly`) at most 10% of cases.

**Evidence (baseline 2026-11-18, wa main 12eb5cc):** llama-3.3-70b 31/76 (40.8%), p95 4.8 s, 1.59 USD/1k, 38 needless handoffs; gpt-oss-120b 50/76 (65.8%), p95 8.4 s, 1.26 USD/1k, wrong_script 8, invented_fact 7, missing_tool:search_catalog 7. Neither model meets the rate gate, so launch needs prompt and tool work on those three classes whichever model is chosen. Register row "Chat agent: live Egyptian golden eval" tracks it.

**Cost if wrong:** Chat launch waits on prompt work longer than it needs to (bar too strict), or a weaker agent ships (bar too loose); the bar is one number in this file and revisable by a new ruling.
