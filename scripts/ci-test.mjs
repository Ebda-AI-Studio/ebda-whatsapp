#!/usr/bin/env node
// CI test runner: `vitest run` with guards for runs that report and then never exit. The verdict always comes from vitest's own exit code,
// its summary, or (when the pool hangs before the summary) per-file marks checked against the collected tests. A guard can turn a hang into
// a verdict, never a missing test into a pass, and every stop is loud (an alert line + a GitHub annotation) so the hang stays visible.
//   pass-through: vitest exits → its exit code.
//   hang after the summary → after GRACE_MS, kill it; exit 0 only if the summary shows no failed files/tests, else 1.
//   every listed file reported, then no summary (the pool never closes; main run 40217314246, PR #11 run 40222548576) → after GRACE_MS,
//     kill it and decide from the marks: FAIL on a failed file (❯ / ×), a printed unhandled error, or any file whose reported test count
//     (minus skipped) differs from `vitest list --json` (a collection that cannot be read also fails).
//   no output for IDLE_MS and no summary → kill it and FAIL, naming every file that never reported (a real hang inside a test).
import { spawn, spawnSync } from 'node:child_process';
import { relative } from 'node:path';

const GRACE_MS = Number(process.env.CI_TEST_GRACE_MS ?? 60_000);
const IDLE_MS = Number(process.env.CI_TEST_IDLE_MS ?? 600_000);
const passArgs = process.argv.slice(2);
// CI_TEST_CMD / CI_TEST_LIST_CMD / CI_TEST_COLLECT_CMD (JSON arrays) replace the commands, for this script's own test only.
const cmdOf = (env, fallback) => (process.env[env] ? JSON.parse(process.env[env]) : fallback);
const [cmd, ...args] = cmdOf('CI_TEST_CMD', ['npx', 'vitest', 'run', ...passArgs]);

/** Runs a `vitest list --json`-shaped command; returns the parsed entries, or null when it cannot be read. */
function listed(envName, fallback) {
  const [c, ...a] = cmdOf(envName, fallback);
  try {
    const r = spawnSync(c, a, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    const j = JSON.parse(r.stdout);
    return Array.isArray(j) ? j : null;
  } catch { return null; }
}
// The files vitest will run. If listing fails, the before-summary guard is off (the idle guard still fails a silent run).
const files = listed('CI_TEST_LIST_CMD', ['npx', 'vitest', 'list', '--filesOnly', '--json', ...passArgs]);
const expected = files?.length ? new Set(files.map((f) => relative(process.cwd(), f.file))) : null;

const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let tail = '';
let summary = null; // { files: string, tests: string }
let timer = null;
let idle = setTimeout(onSilent, IDLE_MS);
const partial = new Map(); // stream -> unfinished last line
const reported = new Map(); // file -> { mark, tests, skipped }
let unhandled = false;

function watch(chunk, out) {
  out.write(chunk);
  clearTimeout(idle);
  idle = setTimeout(onSilent, IDLE_MS);
  const text = strip(chunk.toString());
  tail = (tail + text).slice(-4000);
  const filesLine = /Test Files\s+([^\n]+)/.exec(tail);
  const testsLine = /\n\s*Tests\s+([^\n]+)/.exec(tail);
  if (!summary && filesLine && testsLine && /Duration/.test(tail)) {
    summary = { files: filesLine[1].trim(), tests: testsLine[1].trim() };
    if (timer) clearTimeout(timer);
    timer = setTimeout(onHang, GRACE_MS);
  } // no return: a stall line in the same chunk as the summary still gets its annotation below
  const lines = ((partial.get(out) ?? '') + text).split('\n');
  partial.set(out, lines.pop() ?? '');
  for (const l of lines) {
    // WA-CI-STALL-1: a test about to hit its deadline printed which operations are still pending; surface it on the run page (the verdict is still vitest's).
    if (l.startsWith('{"stall":')) console.log(`::warning title=test stall::${l.replace(/[\r\n%]/g, ' ').slice(0, 900)}`);
    if (/Unhandled (Errors?|Rejection)/.test(l)) unhandled = true;
    const m = /^\s*(✓|❯|×|↓)\s+\|?[\w-]+\|?\s+(\S+\.test\.tsx?)\s+\(([^)]*)\)/.exec(l);
    if (m) reported.set(m[2], { mark: m[1], tests: Number(/(\d+) tests?/.exec(m[3])?.[1] ?? NaN), skipped: Number(/(\d+) skipped/.exec(m[3])?.[1] ?? 0) });
  }
  if (!summary && !timer && expected && [...expected].every((f) => reported.has(f))) timer = setTimeout(onPoolHang, GRACE_MS);
}
child.stdout.on('data', (c) => watch(c, process.stdout));
child.stderr.on('data', (c) => watch(c, process.stderr));

function stop(alert, title, failed, detail) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  console.error(JSON.stringify({ alert, graceMs: GRACE_MS, idleMs: IDLE_MS, ...detail, verdict: failed ? 'fail' : 'pass' }));
  // A GitHub annotation on every stop, green or red, so a hang is never hidden by a passing verdict.
  const msg = `${alert}: ${failed ? 'FAILED' : 'passed'}; ${JSON.stringify(detail).replace(/[\r\n%]/g, ' ').slice(0, 900)}`;
  console.log(`::${failed ? 'error' : 'warning'} title=${title}::${msg}`);
  process.exit(failed ? 1 : 0);
}

function onHang() {
  const failed = /failed/.test(summary.files) || /failed/.test(summary.tests);
  stop('vitest_teardown_hang', 'vitest teardown hang', failed, { files: summary.files, tests: summary.tests });
}

function onPoolHang() {
  if (summary) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } // free the pool before collecting
  const failedFiles = [...reported].filter(([, r]) => r.mark === '❯' || r.mark === '×').map(([f]) => f);
  const collected = listed('CI_TEST_COLLECT_CMD', ['npx', 'vitest', 'list', '--json', ...passArgs]);
  const want = new Map();
  for (const t of collected ?? []) { const f = relative(process.cwd(), t.file); want.set(f, (want.get(f) ?? 0) + 1); }
  const countMismatch = collected
    ? [...new Set([...expected, ...want.keys()])].filter((f) => { const r = reported.get(f); return !r || r.tests - r.skipped !== (want.get(f) ?? 0); })
    : null;
  const failed = failedFiles.length > 0 || unhandled || !collected || countMismatch.length > 0;
  stop('vitest_pool_close_hang', 'vitest pool hang', failed, {
    files: reported.size, failedFiles, unhandled, collected: collected ? collected.length : 'unreadable', countMismatch: countMismatch ?? 'not checked',
  });
}

function onSilent() {
  if (summary) return;
  const unreported = expected ? [...expected].filter((f) => !reported.has(f)) : 'unknown (listing failed)';
  stop('vitest_silent_hang', 'vitest hang', true, { idleMs: IDLE_MS, reported: reported.size, unreported });
}

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  clearTimeout(idle);
  process.exit(code ?? (signal ? 1 : 0));
});
