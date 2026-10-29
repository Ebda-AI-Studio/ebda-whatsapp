# Ruling WA-VECTORIZE-1

**Decision:** the `VECTORIZE` binding (index `ebda-wa-kb`) is live in `wrangler.jsonc`, and `/health` answers 503 `misconfigured` (alert `binding_missing`, P1) when it is absent at runtime.

**Evidence (2026-10-29):**
- Name `ebda-wa-kb`: the binding comment in `wrangler.jsonc`, `docs/ai-agent.md`, and the account list in the approvals queue (created on the coordinator's go).
- 1024 dimensions: the embedder is `@cf/baai/bge-m3` (`EMBEDDING_MODEL` in `src/core/ai/config.ts`), which returns 1024-dim vectors; metric cosine (`score` is read as similarity in `src/core/ai/knowledge.ts`).
- Create command (account 69188202efc4df480140dd76545aa3ab, run by the controller before the deploy): `npx wrangler vectorize create ebda-wa-kb --dimensions=1024 --metric=cosine`.
- The test world gets a local stand-in for the binding from the same config, so `test/health-secrets.test.ts` proves both directions (binding present = 200, absent = 503, name only in the alert line).

**Deploy order:** create the index FIRST; a binding to a missing index fails the deploy (the old version keeps serving).

**Cost if wrong:** if the index is created with other dimensions or metric, every upsert fails at runtime (the agent answers without a knowledge base) until it is deleted and recreated; the data in it is only a derived copy of the workspaces' own knowledge text.
