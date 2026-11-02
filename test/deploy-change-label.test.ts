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
  expect(check(['src/index.ts', 'docs/help/ar/01.md', 'web/src/App.tsx', 'test/seats.test.ts'], []).ok).toBe(true);
});

// Ruling GATE-INVERT-1: deny by default. Table of path -> label required (true) or not (false).
const TABLE: [string, boolean][] = [
  ['src/index.ts', false], ['src/core/meta/client.ts', false], ['web/src/App.tsx', false], ['docs/launch/README.md', false], ['README.md', false],
  ['test/seats.test.ts', false], ['web/brands/ebda/public/brand/symbol-gold.svg', false], ['web/brands/ebda/public/brand/fonts/x.woff2', false],
  ['test/deploy-change-label.test.ts', true],
  ['package.json', true], ['package-lock.json', true], ['yarn.lock', true], ['pnpm-lock.yaml', true], ['bun.lockb', true], ['bun.lock', true], ['npm-shrinkwrap.json', true],
  ['.npmrc', true], ['.nvmrc', true], ['.yarnrc.yml', true], ['wrangler.jsonc', true], ['tsconfig.json', true], ['web/tsconfig.json', true], ['web/vite.config.ts', true],
  ['web/postcss.config.cjs', true], ['web/postcss.config.js', true], ['web/.postcssrc', true], ['web/.postcssrc.json', true], ['web/tailwind.config.ts', true],
  ['web/sub/nested/postcss.config.mjs', true], ['.babelrc', true], ['babel.config.js', true], ['.browserslistrc', true], ['web/.browserslistrc', true],
  ['web/index.html', true], ['web/brands/ebda/brand.ts', true], ['web/brands/ebda/tokens.css', true], ['web/brands/ebda/public/brand/loader.js', true],
  ['scripts/deploy-cf.sh', true], ['scripts/verify-prod.mjs', true], ['scripts/ci/anything.mjs', true], ['scripts/ci-affected.sh', true],
  ['.github/workflows/ci.yml', true], ['.github/workflows/prod-verify.yml', true], ['.github/CODEOWNERS', true], ['migrations/d1/0031_x.sql', true],
  ['vendor/studio/brand/index.ts', true], ['foundation/brand.ts', true], ['vitest.config.mts', true], ['.gitleaks.toml', true], ['scripts/readme.md', true], ['somenewthing.json', true],
];
it('GATE-INVERT-1: the label is required for every path except the explicit allowlist (table incl. nested configs and foreign lockfiles)', () => {
  for (const [file, needs] of TABLE) {
    expect(deployFilesChanged([file]).length === 1, file).toBe(needs);
    expect(check([file], []).ok, `${file} without the label`).toBe(!needs);
    expect(check([file], [LABEL]).ok, `${file} with the label`).toBe(true);
  }
});

it('no lockfile other than package-lock.json exists anywhere in the repo (a foreign lockfile would change what Workers Builds installs)', async () => {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = join(import.meta.dirname, '..');
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', '.wrangler', 'coverage'].includes(e.name)) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f, out);
      else out.push(f.slice(root.length + 1));
    }
    return out;
  };
  const files = walk(root);
  expect(files).toContain('package-lock.json');
  expect(files.filter((f) => /(^|\/)(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|npm-shrinkwrap\.json|\.pnp\.c?js)$/.test(f))).toEqual([]);
  expect(files.filter((f) => /(^|\/)package-lock\.json$/.test(f))).toEqual(['package-lock.json']);
});

it('vite does not auto-discover a PostCSS config: the pipeline is pinned in web/vite.config.ts', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = readFileSync(new URL('../web/vite.config.ts', import.meta.url), 'utf8');
  expect(cfg).toMatch(/css:\s*\{\s*postcss:\s*\{\s*\}/);
});
