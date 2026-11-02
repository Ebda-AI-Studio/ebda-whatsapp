import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs script with no type declarations
import { LABEL, check, deployFilesChanged } from '../scripts/ci/deploy-change-label.mjs';

it('a PR touching a deploy file needs the deploy-change label (Ruling WA-DEPLOY-3 / DEPLOY-PARITY-1)', () => {
  for (const f of ['.github/workflows/prod-verify.yml', 'scripts/deploy-cf.sh', 'package.json', 'scripts/verify-prod.mjs', 'wrangler.jsonc', '.github/workflows/deploy-change-label.yml', 'scripts/ci/deploy-change-label.mjs']) {
    expect(deployFilesChanged([f]), f).toEqual([f]);
    expect(check([f], []).ok, f).toBe(false);
    expect(check([f], [LABEL]).ok, f).toBe(true);
  }
});
it('an ordinary PR needs no label (negative control)', () => {
  expect(check(['src/index.ts', 'docs/help/ar/01.md', '.github/workflows/ci.yml'], []).ok).toBe(true);
});

// Security review (WA-DEPLOY-3): the build runs with the Workers Builds token, so every file the build or deploy reads or executes must be a deploy file.
it('every build and deploy config file in the repo is a deploy file (needs the label)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const root = join(import.meta.dirname, '..');
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.wrangler', 'coverage'].includes(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, out);
      else out.push(relative(root, f));
    }
    return out;
  };
  const files = walk(root);
  const CONFIG = /(^|\/)(vite|postcss|tailwind|babel|rollup|esbuild)\.config\.[cm]?[jt]s$|(^|\/)tsconfig[^/]*\.json$|^\.npmrc$|^\.nvmrc$|^package(-lock)?\.json$|^wrangler\.jsonc$/;
  const configs = files.filter((f) => CONFIG.test(f) && !f.startsWith('deploy/'));
  expect(configs).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'wrangler.jsonc', 'web/vite.config.ts', 'web/tsconfig.json', 'tsconfig.json']));
  expect(configs.filter((f) => deployFilesChanged([f]).length === 0)).toEqual([]);
  // the build imports each brand pack at build time: those brand.ts files are executed with the build token
  const brands = files.filter((f) => /^web\/brands\/[^/]+\/brand\.ts$/.test(f));
  expect(brands.length).toBeGreaterThan(0);
  expect(brands.filter((f) => deployFilesChanged([f]).length === 0)).toEqual([]);
  // the files vite.config.ts imports from the repo (relative imports) are covered too
  const cfg = readFileSync(join(root, 'web/vite.config.ts'), 'utf8');
  for (const m of cfg.matchAll(/from '(\.\.?\/[^']+)'/g)) {
    const rel = join('web', m[1]!).replace(/\.[cm]?[jt]s$/, '');
    const hit = files.find((f) => f.replace(/\.[cm]?[jt]sx?$/, '') === rel);
    expect(hit && deployFilesChanged([hit]).length, `vite.config.ts imports ${m[1]}`).toBe(1);
  }
});
