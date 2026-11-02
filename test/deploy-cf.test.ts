import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

// Ruling WA-DEPLOY-3: production is deployed by Cloudflare Workers Builds running scripts/deploy-cf.sh. No Cloudflare secret exists in GitHub.
const script = readFileSync(new URL('../scripts/deploy-cf.sh', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const wfDir = new URL('../.github/workflows/', import.meta.url);
const workflows = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));

it('no GitHub workflow references a Cloudflare credential or runs a deploy (the token lives only in Workers Builds)', () => {
  expect(workflows).toContain('prod-verify.yml');
  expect(workflows).not.toContain('cf-deploy.yml');
  for (const f of workflows) {
    const text = readFileSync(new URL(f, wfDir), 'utf8');
    expect(text, f).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|wrangler deploy|wrangler d1|deploy-cf\.sh/);
  }
});
it('prod-verify is read-only: dispatch only, no secrets, no pull_request trigger', () => {
  const t = readFileSync(new URL('prod-verify.yml', wfDir), 'utf8');
  expect(t).toMatch(/^on:\n\s+workflow_dispatch:/m);
  expect(t).not.toMatch(/secrets\.|pull_request|push:|schedule:/);
});
it('the deploy script refuses anything but Workers Builds on main, and the wrong Cloudflare account, before any wrangler call', () => {
  const firstWrangler = script.search(/npx wrangler (d1|deploy)/);
  for (const guard of ['WORKERS_CI:-}" = "1"', 'WORKERS_CI_BRANCH:-}" = "main"', '69188202efc4df480140dd76545aa3ab', 'WORKERS_CI_COMMIT_SHA']) {
    const i = script.indexOf(guard);
    expect(i, `missing guard ${guard}`).toBeGreaterThan(-1);
    expect(i, `${guard} must come before the first wrangler call`).toBeLessThan(firstWrangler);
  }
  expect(script).toMatch(/^set -euo pipefail/m);
});
it('the script orders D1 list, D1 apply, deploy with the commit, then verify with the same commit', () => {
  const order = ['wrangler d1 migrations list ebda-wa-platform --remote', 'wrangler d1 migrations apply ebda-wa-platform --remote', 'wrangler deploy --var "COMMIT_SHA:${SHORT_SHA}"', 'verify-prod.mjs --base https://wa.ebda.app --expect "${SHORT_SHA}"'].map((n) => {
    const i = script.indexOf(n);
    expect(i, `missing in deploy-cf.sh: ${n}`).toBeGreaterThan(-1);
    return i;
  });
  expect(order).toEqual([...order].sort((x, y) => x - y));
});
it('package.json carries the build and deploy commands Workers Builds is set to', () => {
  expect(pkg.scripts['build:web']).toBe('vite build web');
  expect(pkg.scripts['deploy:cf']).toBe('bash scripts/deploy-cf.sh');
});
it('wrangler.jsonc pins the personal account and registers the cron the verifier checks', () => {
  const cfg = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  expect(cfg.triggers.crons).toEqual(['17 1 * * *']);
  expect(cfg.account_id).toBe('69188202efc4df480140dd76545aa3ab');
  expect(script).toContain('--cron "17 1 * * *"');
});
