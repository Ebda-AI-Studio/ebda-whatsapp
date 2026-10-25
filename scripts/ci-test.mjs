#!/usr/bin/env node
// CI test runner: `vitest run` with a guard for one failure mode only — the run FINISHES (summary printed) but the Workers pool never
// exits (observed on CI and locally: all files reported, then silence until the job's 15-minute limit). The verdict always comes from
// vitest's own summary and exit code; the guard only stops a process that has already reported, and says so loudly.
//   pass-through: vitest exits → its exit code.
//   hang after the summary → after GRACE_MS, kill it; exit 0 only if the summary shows no failed files/tests, else 1.
//   every expected file reported, then no summary (the pool never closes; seen on CI and locally, 2026-10-25) → after GRACE_MS, kill it;
//     the verdict comes from the per-file marks: any failed file (❯ / ×) or a printed unhandled error fails, otherwise it passes.
//   a file still unreported and no summary → never killed here (the job timeout stays the backstop for a real hang inside a test).
import { spawn, spawnSync } from 'node:child_process';
import { relative } from 'node:path';

const GRACE_MS = Number(process.env.CI_TEST_GRACE_MS ?? 60_000);
// CI_TEST_CMD (JSON array) replaces the command, for this script's own test only.
const [cmd, ...args] = process.env.CI_TEST_CMD ? JSON.parse(process.env.CI_TEST_CMD) : ['npx', 'vitest', 'run', ...process.argv.slice(2)];
// The files vitest will run (CI_TEST_LIST_CMD replaces the command for this script's own test). If listing fails, that guard is simply off.
const [listCmd, ...listArgs] = process.env.CI_TEST_LIST_CMD ? JSON.parse(process.env.CI_TEST_LIST_CMD) : ['npx', 'vitest', 'list', '--filesOnly', '--json', ...process.argv.slice(2)];
let expected = null;
try {
  const listed = JSON.parse(spawnSync(listCmd, listArgs, { encoding: 'utf8', timeout: 120_000 }).stdout);
  expected = new Set(listed.map((f) => relative(process.cwd(), f.file)));
  if (!expected.size) expected = null;
} catch { expected = null; }
const reported = new Map(); // file -> mark (✓ ❯ × ↓)
const partial = new Map(); // stream -> unfinished last line
let unhandled = false;

const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
let tail = '';
let summary = null; // { files: string, tests: string }
let timer = null;

function watch(chunk, out) {
  out.write(chunk);
  tail = (tail + strip(chunk.toString())).slice(-4000);
  const files = /Test Files\s+([^\n]+)/.exec(tail);
  const tests = /\n\s*Tests\s+([^\n]+)/.exec(tail);
  if (!summary && files && tests && /Duration/.test(tail)) {
    summary = { files: files[1].trim(), tests: tests[1].trim() };
    if (timer) clearTimeout(timer);
    timer = setTimeout(onHang, GRACE_MS);
    return;
  }
  const lines = ((partial.get(out) ?? '') + strip(chunk.toString())).split('\n');
  partial.set(out, lines.pop() ?? '');
  for (const l of lines) {
    if (/Unhandled (Errors?|Rejection)/.test(l)) unhandled = true;
    const m = /^\s*(✓|❯|×|↓)\s+\|?[\w-]+\|?\s+(\S+\.test\.tsx?)\b/.exec(l);
    if (m) reported.set(m[2], m[1]);
  }
  if (!summary && !timer && expected && [...expected].every((f) => reported.has(f))) timer = setTimeout(onPoolHang, GRACE_MS);
}
child.stdout.on('data', (c) => watch(c, process.stdout));
child.stderr.on('data', (c) => watch(c, process.stderr));

function onHang() {
  const failed = /failed/.test(summary.files) || /failed/.test(summary.tests);
  console.error(JSON.stringify({ alert: 'vitest_teardown_hang', graceMs: GRACE_MS, files: summary.files, tests: summary.tests, verdict: failed ? 'fail' : 'pass' }));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  process.exit(failed ? 1 : 0);
}

function onPoolHang() {
  if (summary) return;
  const failedFiles = [...reported].filter(([, mark]) => mark === '❯' || mark === '×').map(([f]) => f);
  const failed = failedFiles.length > 0 || unhandled;
  console.error(JSON.stringify({ alert: 'vitest_pool_close_hang', graceMs: GRACE_MS, files: reported.size, failedFiles, unhandled, verdict: failed ? 'fail' : 'pass' }));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  process.exit(failed ? 1 : 0);
}

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  process.exit(code ?? (signal ? 1 : 0));
});
