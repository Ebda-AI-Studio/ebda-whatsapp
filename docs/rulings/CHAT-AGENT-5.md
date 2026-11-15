# Ruling CHAT-AGENT-5

**Decision:** The agent's quality is measured by a golden set (76 conversations, `test/eval/golden-cases.ts`) with a judge-free rubric. Default CI runs it with a SCRIPTED model (76/76 must pass, plus five negative controls that must fail): that proves the cases, the rubric and the harness, not a model. A run against a REAL model is opt-in (`CHAT_EVAL_LIVE=1` + endpoint settings), never in default CI because it costs money, and a model score is only quoted from such a run.

**Evidence:** `test/chat-golden-eval.test.ts`, `test/chat-golden-live.test.ts`, `docs/ai-agent.md` "Golden eval".

**Cost if wrong:** a green default CI says nothing about Llama's judgement on Egyptian Arabic (a rubric regex can also reject a good paraphrase); until the live run is done on the production model, "the agent works" is unproven.
