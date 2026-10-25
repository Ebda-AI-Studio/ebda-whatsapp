import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const script = join(import.meta.dirname, '..', 'scripts', 'ci-test.mjs');
const fake = (body: string) => JSON.stringify(['node', '-e', body]);
const run = (body: string, graceMs = 300) =>
  spawnSync('node', [script], { env: { ...process.env, CI_TEST_CMD: fake(body), CI_TEST_GRACE_MS: String(graceMs) }, encoding: 'utf8', timeout: 20_000 });
const SUMMARY_OK = 'console.log(" Test Files  3 passed (3)\\n      Tests  12 passed (12)\\n   Duration  1.2s");';
const SUMMARY_FAIL = 'console.log(" Test Files  1 failed | 2 passed (3)\\n      Tests  1 failed | 11 passed (12)\\n   Duration  1.2s");';
const HANG = 'setInterval(() => {}, 1000);';

it('passes vitest\'s own exit code through when it exits', () => {
  expect(run(`${SUMMARY_FAIL} process.exit(3);`).status).toBe(3);
  expect(run(`${SUMMARY_OK} process.exit(0);`).status).toBe(0);
});

it('a run that reported success and then hangs in teardown is stopped, says so, and passes', () => {
  const r = run(SUMMARY_OK + HANG);
  expect(r.status).toBe(0);
  expect(r.stderr).toContain('vitest_teardown_hang');
});

it('a run that reported a failure and then hangs is stopped and fails', () => {
  const r = run(SUMMARY_FAIL + HANG);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('"verdict":"fail"');
});

it('a run that never printed a summary is never stopped by this guard (the job timeout stays the backstop)', () => {
  const t0 = Date.now();
  const r = run('console.log("still testing…"); setTimeout(() => process.exit(0), 3000);', 300);
  expect(r.status).toBe(0);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500); // ran to its own end, far past the 300 ms grace
  expect(r.stderr).not.toContain('vitest_teardown_hang');
}, 30_000);
