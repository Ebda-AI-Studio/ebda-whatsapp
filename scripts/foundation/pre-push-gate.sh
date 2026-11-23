#!/usr/bin/env bash
# The light pre-push gate every Ebda repo runs (vendored as scripts/foundation/pre-push-gate.sh; a repo's scripts/ci/pre-push-gate.sh is a thin wrapper).
# Fast checks only (a few seconds): the action-pin check, gitleaks on the push range, prettier on the files this push changed.
# Lint, typecheck, prisma generate, package builds and the full suite run in CI, not here. Run from the repo root (the git hook does).
#
# Product-specific steps are NOT here: when PRE_PUSH_EXTRA (default scripts/ci/pre-push-extra.sh) exists, it runs LAST with BASE (the merge base
# with origin/main) exported, under the same `set -euo pipefail`; its failure fails the gate. The Store keeps its related-test and scanner steps there.
#   PRE_PUSH_ACTION_PINS  script that proves every `uses:` is pinned to a 40-hex SHA (default scripts/check-action-pins.sh). It is REQUIRED: a
#                         missing script fails the gate (a declared gate must not fail open). Set it to the empty string to opt out explicitly.
#   PRE_PUSH_EXTRA        the product hook above; set to the empty string for none.
set -euo pipefail

# Mirrors CI's client-secret-scan job: every `uses:` pinned to a 40-hex SHA.
PINS="${PRE_PUSH_ACTION_PINS-scripts/check-action-pins.sh}"
if [ -n "$PINS" ]; then bash "$PINS"; fi

BASE=$(git merge-base origin/main HEAD 2>/dev/null || true)
if [ -z "$BASE" ]; then
  echo "! pre-push: no merge base with origin/main; secret scan and format check left to CI"
  exit 0
fi

# gitleaks on the push range only (same config as CI's gitleaks workflow)
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --source . --config .gitleaks.toml --log-opts="${BASE}..HEAD" --redact --exit-code 1
else
  echo "! gitleaks not installed; CI scans this range"
fi

# prettier on the changed files only
FILES=$(git diff --name-only --diff-filter=ACMR "$BASE"..HEAD | grep -E '\.(ts|tsx|js|jsx|json|md)$' | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)
if [ -n "$FILES" ]; then printf '%s\n' "$FILES" | xargs npx prettier --check; fi

EXTRA="${PRE_PUSH_EXTRA-scripts/ci/pre-push-extra.sh}"
if [ -n "$EXTRA" ] && [ -f "$EXTRA" ]; then
  export BASE
  bash "$EXTRA"
fi

echo "OK light pre-push gate passed (lint/typecheck/full suite run in CI)"
