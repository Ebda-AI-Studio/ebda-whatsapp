#!/usr/bin/env bash
# Installs the pre-push guard gate. Writes a stub into the SHARED git hooks dir (<git-common-dir>/hooks/pre-push), so it covers the root
# checkout and every worktree, and the global ~/.claude/git-hooks dispatcher (core.hooksPath, which keeps the worktree post-checkout
# deps hook) chains to it. The stub runs the tracked scripts/prepush-guards.mjs of whichever worktree is pushing.
set -euo pipefail
hooks="$(git rev-parse --path-format=absolute --git-common-dir)/hooks"
mkdir -p "$hooks"
cat > "$hooks/pre-push" <<'STUB'
#!/usr/bin/env bash
top="$(git rev-parse --show-toplevel)"
[ -f "$top/scripts/prepush-guards.mjs" ] || exit 0
cat >/dev/null
exec node "$top/scripts/prepush-guards.mjs"
STUB
chmod +x "$hooks/pre-push"
echo "installed $hooks/pre-push"
