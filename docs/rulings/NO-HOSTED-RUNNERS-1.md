# NO-HOSTED-RUNNERS-1

**Decision:** no workflow runs on a GitHub-hosted runner, and none can fall back to one. Every `runs-on` is a repo variable with a Mac-label fallback (`'["ebda-mac-light"]'`; the deploy job keeps its own `EBDA_DEPLOY_RUNS_ON`), the setup-node remote `cache:` is gone (the Mac pool has `~/.npm` locally), and `test/workflow-no-hosted-runners.test.ts` fails on any `ubuntu-*` / `windows-*` / `macos-*` image name in a `runs-on` line (the detector is tested on samples; mutation: a hosted fallback in nightly.yml fails the file's case).

**Evidence:** Ahmad, 2026-11-16: never GitHub-hosted runners (no hosted minutes). Measured 2026-11-18 on origin/main: 15 `ubuntu-24.04` references in this repo's workflows, 13 of them `runs-on` fallbacks that would silently take over the moment a variable is unset.

**Fork PRs (deploy-change-label.yml):** the job used to give a fork's PR a hosted runner so the required check always reported. There is no hosted runner now, so a fork PR asks for the label `fork-pr-no-runner`, which no runner has: the job queues and the required check never reports, so the PR cannot merge and fork code never runs on the Mac pool (fail closed). The repo is private and takes no fork PRs today.

**Supersedes** the hosted-fallback parts of CI-UMBRA-ON-1, WA-DEPLOY-2 and WA-CI-ON-1 (their text is left as history; Umbra is retired). Left alone on purpose, not a `runs-on`: docs/launch/README.md line 87 and 105, docs/plans/2026-10-24-phase1-foundation.md line 33.

**Cost if wrong:** a job whose variable is unset waits for a Mac runner instead of running hosted; a fork PR's deploy-label check hangs until the 24 h queue timeout instead of reporting.
