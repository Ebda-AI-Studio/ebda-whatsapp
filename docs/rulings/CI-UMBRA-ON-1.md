# CI-UMBRA-ON-1

**Decision:** the deploy-change label check and the production deploy (`cf-deploy.yml`) run on the Umbra self-hosted runner when the repo variable `EBDA_RUNS_ON` is set, else on the pinned GitHub-hosted `ubuntu-24.04`. This supersedes RUNS-ON-NEVER-1 for these two jobs. The label check never runs a fork's PR on the self-hosted runner.

**Evidence:** Ahmad, 2026-11-03: "No spending limit yet only umbra". The Whisky-11 org has no GitHub-hosted minutes left, so a job pinned to GitHub-hosted fails within 2 seconds without running: PR #52's label check failed that way, and the next push to main would fail its deploy the same way.

**Cost if wrong:** the production deploy (with its secrets) runs on the shared, non-ephemeral Umbra VM, which also runs PR code from this repo. A PR author with write access could tamper with the runner between jobs. Today only Ahmad and his agents have write access; the durable fix is moving the deploy to Cloudflare Workers Builds (WA-DEPLOY-3), which takes the token out of GitHub entirely. Unset `EBDA_RUNS_ON` to return to GitHub-hosted.
