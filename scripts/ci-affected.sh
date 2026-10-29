#!/usr/bin/env bash
# Which tests a CI run needs (Ruling WA-CI-ON-1). Prints one line: `full` or `affected`.
#   full     = every push to main, and any PR that touches a shared input (below) or anything outside src/, web/src/ and test/.
#   affected = a PR whose changes are all source/test files: the caller runs the static guards (node project) in full, plus only the
#              workers and web tests the change reaches (`vitest --changed`, module graph). `--passWithNoTests` covers "nothing reached".
# Inputs: EVENT_NAME (github.event_name), BASE_REF (github.base_ref). Needs the base ref fetched (checkout fetch-depth: 0).
# Anything unknown falls to `full`: this script may only ever make CI faster, never skip a test it cannot account for.
set -euo pipefail
if [ "${EVENT_NAME:-}" != "pull_request" ] || [ -z "${BASE_REF:-}" ]; then echo full; exit 0; fi
changed=$(git diff --name-only "origin/${BASE_REF}...HEAD") || { echo full; exit 0; }
[ -n "$changed" ] || { echo full; exit 0; }
while IFS= read -r f; do
  case "$f" in
    # shared inputs every test depends on (config, dependencies, schema, test harness, CI itself)
    package.json|package-lock.json|wrangler.jsonc|vitest.config.mts|tsconfig.json|migrations/*|test/setup.ts|test/helpers/*|scripts/ci-test.mjs|scripts/ci-affected.sh|.github/workflows/ci.yml) echo full; exit 0 ;;
    src/*|web/src/*|test/*.test.ts|test/*.test.tsx) ;;
    *) echo full; exit 0 ;;
  esac
done <<< "$changed"
echo affected
