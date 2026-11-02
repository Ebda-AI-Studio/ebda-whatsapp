import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Ruling WA-CI-ON-1: PR CI follows the Ebda CI pattern. Pinned so a later edit cannot quietly drop one of the rules.
const wf = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

it('runs on pull requests and on main, one run per PR (a newer push cancels the older), each main push on its own', () => {
  expect(wf).toMatch(/on:\n\s+pull_request:\n\s+push:\n\s+branches: \[main\]/);
  expect(wf).toContain("group: ci-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}");
  expect(wf).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
});
it('the job is bounded, never runs a fork on the self-hosted runner, and falls back to GitHub-hosted when EBDA_RUNS_ON is unset', () => {
  expect(wf).toMatch(/timeout-minutes: \d+/);
  expect(wf).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  expect(wf).toContain("runs-on: ${{ fromJSON(vars.EBDA_RUNS_ON || '\"ubuntu-latest\"') }}");
});
it('no remote Actions cache on the self-hosted runner (the npm cache only when hosted)', () => {
  expect(wf).toContain("cache: ${{ vars.EBDA_RUNS_ON == '' && 'npm' || '' }}");
  expect(wf).not.toMatch(/actions\/cache@/);
});
it('typecheck always; a PR runs only the tests its change reaches, main and config/migration/test-setup changes run everything', () => {
  expect(wf).toContain('npm run typecheck');
  expect(wf).toContain('scripts/ci-affected.sh');
  expect(wf).toMatch(/fetch-depth: 0/);
  expect(wf).toContain('npm audit --audit-level=low');
});
it('scripts/ci-affected.sh picks the full suite for shared inputs and --changed for the rest', () => {
  const s = readFileSync(new URL('../scripts/ci-affected.sh', import.meta.url), 'utf8');
  for (const shared of ['package.json', 'package-lock.json', 'wrangler.jsonc', 'vitest.config.mts', 'migrations/', 'test/setup.ts', 'test/helpers/', 'scripts/ci-test.mjs', '.github/workflows/ci.yml']) expect(s, shared).toContain(shared);
  expect(s).toContain('--changed');
  expect(s).toContain('--passWithNoTests');
});
