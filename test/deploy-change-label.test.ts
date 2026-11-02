import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with no type declarations
import { LABEL, check, deployFilesChanged } from '../scripts/ci/deploy-change-label.mjs';

it('a PR touching a deploy file needs the deploy-change label (Ruling WA-DEPLOY-2 / DEPLOY-PARITY-1)', () => {
  for (const f of ['.github/workflows/cf-deploy.yml', 'scripts/deploy.sh', 'scripts/verify-prod.mjs', 'wrangler.jsonc', '.github/workflows/deploy-change-label.yml', 'scripts/ci/deploy-change-label.mjs']) {
    expect(deployFilesChanged([f]), f).toEqual([f]);
    expect(check([f], []).ok, f).toBe(false);
    expect(check([f], [LABEL]).ok, f).toBe(true);
  }
});
it('an ordinary PR needs no label (negative control)', () => {
  expect(check(['src/index.ts', 'docs/help/ar/01.md', '.github/workflows/ci.yml'], []).ok).toBe(true);
});
