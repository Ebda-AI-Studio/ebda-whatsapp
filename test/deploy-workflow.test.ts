import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const wf = readFileSync(new URL('../.github/workflows/cf-deploy.yml', import.meta.url), 'utf8');
const at = (needle: string): number => {
  const i = wf.indexOf(needle);
  expect(i, `missing in cf-deploy.yml: ${needle}`).toBeGreaterThan(-1);
  return i;
};

it('runs only when a human dispatches it: no push, pull_request, schedule or workflow_run trigger', () => {
  const on = /^on:\n((?:[ \t]+.*\n|\n)+?)(?=\S)/m.exec(wf)?.[1] ?? '';
  expect(on.trim()).toBe('workflow_dispatch:');
  expect(wf).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m);
});
it('one deploy at a time and never cancelled halfway; bounded; same runner rule as ci.yml; no remote cache on self-hosted', () => {
  expect(wf).toMatch(/concurrency:\n\s+group: deploy\n\s+cancel-in-progress: false/);
  expect(wf).toMatch(/timeout-minutes: \d+/);
  expect(wf).toContain("runs-on: ${{ fromJSON(vars.EBDA_RUNS_ON || '\"ubuntu-latest\"') }}");
  expect(wf).toContain("cache: ${{ vars.EBDA_RUNS_ON == '' && 'npm' || '' }}");
});
it('refuses the wrong Cloudflare account, a missing token and a commit that is not on main, before anything runs', () => {
  expect(wf).toContain('EXPECTED_ACCOUNT_ID: 69188202efc4df480140dd76545aa3ab');
  expect(wf).toContain('"${CLOUDFLARE_ACCOUNT_ID}" != "${EXPECTED_ACCOUNT_ID}"');
  expect(wf).toContain('merge-base --is-ancestor');
  expect(at('Guards (account')).toBeLessThan(at('npm ci'));
});
it('orders the steps: typecheck, D1 list, D1 apply, deploy with the commit, verify with the same commit, then failure notice', () => {
  const order = ['npm run typecheck', 'wrangler d1 migrations list ebda-wa-platform --remote', 'wrangler d1 migrations apply ebda-wa-platform --remote', 'wrangler deploy --var "COMMIT_SHA:${SHORT_SHA}"', 'verify-prod.mjs --base https://wa.ebda.app --expect "${SHORT_SHA}"', 'if: failure()'].map(at);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(wf).toContain('--cron "17 1 * * *"');
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
