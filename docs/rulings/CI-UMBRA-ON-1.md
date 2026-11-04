# CI-UMBRA-ON-1

**Decision:** the deploy-change label check runs on the Umbra self-hosted runner when `EBDA_RUNS_ON` is set (fork PRs always get GitHub-hosted, and the gate is never skipped). The production deploy (`cf-deploy.yml`) has its OWN switch, `EBDA_DEPLOY_RUNS_ON` (unset = pinned GitHub-hosted `ubuntu-24.04`), so moving PR jobs to the shared VM never silently moves the job holding production secrets. Supersedes RUNS-ON-NEVER-1 for these two jobs. Security review on the first draft flagged both points (privileged job on a shared runner; a skipped required check passing).

**Evidence:** Ahmad, 2026-11-03: "No spending limit yet only umbra". The Whisky-11 org has no GitHub-hosted minutes left, so a job pinned to GitHub-hosted fails within 2 seconds without running: PR #52's label check failed that way, and the next push to main would fail its deploy the same way.

**Cost if wrong:** the production deploy (with its secrets) runs on the shared, non-ephemeral Umbra VM, which also runs PR code from this repo. A PR author with write access could tamper with the runner between jobs. Today only Ahmad and his agents have write access; the durable fix is moving the deploy to Cloudflare Workers Builds (WA-DEPLOY-3), which takes the token out of GitHub entirely. Unset `EBDA_RUNS_ON` to return to GitHub-hosted.
