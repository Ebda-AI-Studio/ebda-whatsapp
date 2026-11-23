#!/usr/bin/env node
// Pre-push gate: runs ONLY the repo-wide guard tests (legacy brand strings, Arabic-Indic digits, offboarding / plan / route
// decisions, ...) and `tsc --noEmit`, so a PR cannot reach CI red on a guard its author never ran. Never the full suite.
// A guard test opts in by carrying `// @repo-guard` in its first 3 lines; this script finds them by that tag, so there is no list to maintain.
// Env (this script's own test only): PREPUSH_GUARD_DIR (where to look), PREPUSH_GUARD_CMD (JSON array replacing the vitest command),
// PREPUSH_SKIP_TSC=1. Install the git hook with `npm run hooks:install`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIR = process.env.PREPUSH_GUARD_DIR ?? join(ROOT, 'test');
const TAG = /^\s*\/\/\s*@repo-guard\b/;

export function discover(dir = DIR) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.test.ts'))
    .filter((n) => readFileSync(join(dir, n), 'utf8').split('\n', 3).some((l) => TAG.test(l)))
    .map((n) => relative(ROOT, join(dir, n)))
    .sort();
}

function run(cmd, args) {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  return { ok: r.status === 0, s: ((Date.now() - t) / 1000).toFixed(1) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.error('prepush-guards: node_modules missing; run `bash ~/.claude/scripts/wt-deps.sh .` (worktree) or npm ci. Push blocked.');
    process.exit(1);
  }
  const files = discover();
  if (!files.length) { console.error('prepush-guards: no test carries `// @repo-guard`; refusing to pass on zero guards.'); process.exit(1); }
  console.log(`-> pre-push: ${files.length} repo-wide guard tests + tsc (full suite runs in CI)`);
  const [c, ...a] = process.env.PREPUSH_GUARD_CMD ? JSON.parse(process.env.PREPUSH_GUARD_CMD) : ['npx', 'vitest', 'run', ...files];
  const guards = run(c, a);
  const tsc = process.env.PREPUSH_SKIP_TSC === '1' ? { ok: true, s: 'skipped' } : run('npx', ['tsc', '--noEmit']);
  console.log(`-> guards ${guards.ok ? 'ok' : 'FAILED'} (${guards.s}s), tsc ${tsc.ok ? 'ok' : 'FAILED'} (${tsc.s}s)`);
  if (!guards.ok || !tsc.ok) { console.error('pre-push blocked: fix the failing guard above (the same test fails in CI).'); process.exit(1); }
}
