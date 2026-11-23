import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const script = join(import.meta.dirname, '..', 'scripts', 'prepush-guards.mjs');
const run = (env: Record<string, string>) => spawnSync('node', [script], { env: { ...process.env, PREPUSH_SKIP_TSC: '1', ...env }, encoding: 'utf8', timeout: 20_000 });

it('discovers the repo-wide guards by tag', async () => {
  const { discover } = await import(script);
  expect(discover()).toEqual(expect.arrayContaining(['guards', 'brand', 'offboarding', 'plan-required', 'integrator-tokens', 'route-decisions'].map((n) => `test/${n}.test.ts`)));
});

it('exits non-zero when a guard fails and zero when they pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guards-'));
  writeFileSync(join(dir, 'x.test.ts'), '// @repo-guard\n');
  const bad = run({ PREPUSH_GUARD_DIR: dir, PREPUSH_GUARD_CMD: JSON.stringify(['node', '-e', 'process.exit(1)']) });
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain('pre-push blocked');
  expect(run({ PREPUSH_GUARD_DIR: dir, PREPUSH_GUARD_CMD: JSON.stringify(['node', '-e', '0']) }).status).toBe(0);
});

it('refuses to pass when no test carries the tag', () => {
  expect(run({ PREPUSH_GUARD_DIR: mkdtempSync(join(tmpdir(), 'guards-')) }).status).toBe(1);
});
