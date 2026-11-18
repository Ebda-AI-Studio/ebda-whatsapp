import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

const wf = readFileSync(new URL('../.github/workflows/cf-deploy.yml', import.meta.url), 'utf8');
const at = (needle: string): number => {
  const i = wf.indexOf(needle);
  expect(i, `missing in cf-deploy.yml: ${needle}`).toBeGreaterThan(-1);
  return i;
};

it('deploys on a push to main and on dispatch only (Ruling WA-DEPLOY-2): no pull_request, schedule or workflow_run trigger', () => {
  const on = /^on:\n((?:[ \t]+.*\n|\n)+?)(?=\S)/m.exec(wf)?.[1] ?? '';
  expect(on.replace(/\s+/g, ' ').trim()).toBe('push: branches: [main] workflow_dispatch:');
  expect(wf).not.toMatch(/^\s+(pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
});
it('one deploy at a time and never cancelled halfway; bounded; its own runner switch EBDA_DEPLOY_RUNS_ON, never the PR runner switch EBDA_RUNS_ON (CI-UMBRA-ON-1)', () => {
  expect(wf).toMatch(/concurrency:\n\s+group: deploy\n\s+cancel-in-progress: false/);
  expect(wf).toMatch(/timeout-minutes: \d+/);
  expect(wf).toContain(`runs-on: \${{ fromJSON(vars.EBDA_DEPLOY_RUNS_ON || '["ebda-mac-light"]') }}`);
  expect(wf).not.toContain('vars.EBDA_RUNS_ON');
  expect(wf).not.toMatch(/ubuntu-latest/);
});
const script = readFileSync(new URL('../scripts/deploy.sh', import.meta.url), 'utf8');

it('the deploy logic lives in scripts/deploy.sh, which the workflow calls (one path for the Mac and for Actions)', () => {
  expect(wf).toContain('bash scripts/deploy.sh');
  for (const logic of ['wrangler d1 migrations', 'wrangler deploy', 'verify-prod.mjs', 'merge-base --is-ancestor']) expect(wf, `${logic} must not be inlined in the workflow`).not.toContain(logic);
});
it('the script refuses the wrong Cloudflare account and a commit that is not on origin/main, before any wrangler call', () => {
  expect(script).toContain('69188202efc4df480140dd76545aa3ab');
  expect(script).toContain('merge-base --is-ancestor');
  const firstWrangler = script.search(/npx wrangler (d1|deploy)/);
  expect(script.indexOf('merge-base --is-ancestor')).toBeLessThan(firstWrangler);
  expect(script.indexOf('69188202efc4df480140dd76545aa3ab')).toBeLessThan(firstWrangler);
  expect(script).toMatch(/^set -euo pipefail/m);
});
it('the script orders D1 list, D1 apply, deploy with the commit, then verify with the same commit and the cron', () => {
  const order = ['wrangler d1 migrations list ebda-wa-platform --remote', 'wrangler d1 migrations apply ebda-wa-platform --remote', 'wrangler deploy --var "COMMIT_SHA:${SHORT_SHA}"', 'verify-prod.mjs --base https://wa.ebda.app --expect "${SHORT_SHA}"'].map((n) => {
    const i = script.indexOf(n);
    expect(i, `missing in deploy.sh: ${n}`).toBeGreaterThan(-1);
    return i;
  });
  expect(order).toEqual([...order].sort((x, y) => x - y));
  expect(script).toContain('--cron "17 1 * * *"');
});
it('the job runs in the `production` environment (which holds the secrets) and installs without lifecycle scripts', () => {
  expect(wf).toMatch(/^\s+environment: production$/m);
  expect(wf).toContain('npm ci --ignore-scripts');
});
it('secrets are scoped to the single step that needs them: none at workflow or job level, and the checkout / install steps never see them', () => {
  const jobHead = wf.slice(at('jobs:'), at('steps:'));
  const workflowHead = wf.slice(0, at('jobs:'));
  expect(jobHead).not.toMatch(/secrets\./);
  expect(workflowHead).not.toMatch(/secrets\./);
  const beforeDeploy = wf.slice(0, at('name: Deploy'));
  expect(beforeDeploy).not.toMatch(/secrets\./);
  const deployStep = wf.slice(at('name: Deploy'), at('name: Notify failure'));
  expect(deployStep).toContain('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}');
});
it('the failure notice carries the commit and the run link only: no secret, phone or message content in its text', () => {
  const notice = wf.slice(at('Notify failure (Telegram)'));
  const text = /--data-urlencode "text=([^"]*)"/.exec(notice)?.[1] ?? '';
  expect(text).toContain('deploy FAILED');
  expect(text).not.toMatch(/secrets\.|TOKEN|phone|wa_id/i);
  expect(notice).toMatch(/TELEGRAM_BOT_TOKEN: \$\{\{ secrets\.TELEGRAM_BOT_TOKEN \}\}/);
});
it('wrangler.jsonc registers the cron the workflow verifies', () => {
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  expect(cfg.triggers.crons).toEqual(['17 1 * * *']);
  expect(cfg.account_id).toBe('69188202efc4df480140dd76545aa3ab');
});
it('the deploy job runs only on refs/heads/main, so a dispatch from another branch is skipped (WA-DEPLOY-2)', () => {
  expect(wf).toMatch(/^\s+if: github\.ref == 'refs\/heads\/main'$/m);
});
it('no workflow that references CLOUDFLARE_API_TOKEN has a pull_request or pull_request_target trigger (WA-DEPLOY-2)', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  expect(files).toContain('cf-deploy.yml');
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    if (text.includes('CLOUDFLARE_API_TOKEN')) expect(text, f).not.toMatch(/^\s+(pull_request|pull_request_target):?/m);
  }
  // negative control: the PR workflows exist and carry no such secret
  expect(readFileSync(new URL('ci.yml', dir), 'utf8')).not.toContain('CLOUDFLARE_API_TOKEN');
});

// Behavioural proof of the "commit is on main" guard against a private repo: deploy.sh must use the checkout's origin/main (no network, no credentials).
it('the on-main guard uses the checked-out origin/main without fetching, passes for a merged commit and still FAILS for one that is not on main', async () => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(new URL('../scripts/deploy.sh', import.meta.url), join(dir, 'scripts/deploy.sh'));
  copyFileSync(new URL('../wrangler.jsonc', import.meta.url), join(dir, 'wrangler.jsonc'));
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // origin points at an unreachable URL: any fetch would fail, so success proves no fetch happened.
  git('remote', 'add', 'origin', 'https://invalid.invalid/none.git');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const run = () => spawnSync('bash', ['scripts/deploy.sh'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_TERMINAL_PROMPT: '0' } });
  const ok = run();
  expect(ok.stderr).not.toContain('cannot fetch');
  expect(ok.stderr).not.toContain('not an ancestor');
  expect(ok.stderr).toContain('web/dist is missing'); // got past the guard
  writeFileSync(join(dir, 'x'), '1');
  git('add', 'x');
  git('commit', '-q', '-m', 'unmerged'); // HEAD is ahead of origin/main
  const bad = run();
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain('is not an ancestor of origin/main');
});

// Self-hosted Macs must never pull the remote Actions cache (14 GB once, a deploy stuck 5+ min in "Setup Node.js"): setup-node `cache:` is only ever a runner-switch conditional.
it('no workflow has a setup-node `cache:` at all (every job is on the Mac pool; the remote Actions cache is never used)', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  expect(files).toContain('cf-deploy.yml');
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    expect(text, f).not.toMatch(/^\s*cache:\s*['"]?(npm|pnpm|yarn)['"]?\s*(#.*)?$/m);
  }
  expect(wf).not.toMatch(/^\s*cache:/m);
});
