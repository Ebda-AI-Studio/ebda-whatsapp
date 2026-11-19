# Ruling WA-AI-REVIEW-1 - ebda-whatsapp gets the same independent AI review gate as ebda-store (2026-11-17)

Evidence: `ebda-whatsapp` had no AI review workflow (`.github/workflows`: ci, cf-deploy, deploy-change-label, gitleaks, nightly, capability-ratchet). The review-gated merge rule (merge only with an `ai-review-passed` that something other than the author set, plus `money-review-passed` on `risky` PRs) therefore had nothing to read, and a PR here could merge on CI alone.

Decision: port ebda-store's gate unchanged. `.github/workflows/ai-review.yml` (jobs identical to the store and foundation copies; the file header says so) and `.github/ai-review/{review.mjs,risky-paths.mjs,prompt.md}`. It runs from the BASE branch on `pull_request_target`, the PR is only diffed as data, classification is fail-closed (only docs, markdown and NEWLY ADDED tests skip review; a modified or deleted existing test is reviewed because the safety guards are test files), a diff over 400 KB needs a human `ai-review-passed`, fork PRs are never reviewed with secrets. Every job runs on the light runners (`EBDA_LIGHT_RUNS_ON || EBDA_RUNS_ON`). The org secret `CLAUDE_CODE_OAUTH_TOKEN` is visible to this repo; the labels `ai-review-passed` and `risky` already exist (`risky-path` is created by the workflow).

Pinned by `test/ai-review-gate.test.ts` (classifier with this repo's paths, light runners on all four jobs, base checkout, fork gate without the secret, label-removal rules, bounded reviewer call).

Not verified until a PR runs it: that the `AI review` check appears, goes green on a docs-only PR and red on an unlabelled fork. Cost if wrong: a PR waits on a check that does not report; nothing merges without it, so the failure is a stall, not a bypass.
