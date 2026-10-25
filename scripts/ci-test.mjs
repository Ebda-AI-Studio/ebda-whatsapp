#!/usr/bin/env node
// CI test runner: `vitest run` with a guard for one failure mode only — the run FINISHES (summary printed) but the Workers pool never
// exits (observed on CI and locally: all files reported, then silence until the job's 15-minute limit). The verdict always comes from
// vitest's own summary and exit code; the guard only stops a process that has already reported, and says so loudly.
//   pass-through: vitest exits → its exit code.
//   hang after the summary → after GRACE_MS, kill it; exit 0 only if the summary shows no failed files/tests, else 1.
//   no summary at all → never killed here (the job timeout stays the backstop for a real hang inside a test).
import { spawn } from 'node:child_process';

const GRACE_MS = Number(process.env.CI_TEST_GRACE_MS ?? 60_000);
// CI_TEST_CMD (JSON array) replaces the command, for this script's own test only.
const [cmd, ...args] = process.env.CI_TEST_CMD ? JSON.parse(process.env.CI_TEST_CMD) : ['npx', 'vitest', 'run', ...process.argv.slice(2)];
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
    timer = setTimeout(onHang, GRACE_MS);
  }
}
child.stdout.on('data', (c) => watch(c, process.stdout));
child.stderr.on('data', (c) => watch(c, process.stderr));

function onHang() {
  const failed = /failed/.test(summary.files) || /failed/.test(summary.tests);
  console.error(JSON.stringify({ alert: 'vitest_teardown_hang', graceMs: GRACE_MS, files: summary.files, tests: summary.tests, verdict: failed ? 'fail' : 'pass' }));
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  process.exit(failed ? 1 : 0);
}

child.on('exit', (code, signal) => {
  if (timer) clearTimeout(timer);
  process.exit(code ?? (signal ? 1 : 0));
});
