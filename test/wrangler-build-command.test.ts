import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const BUILD = 'node scripts/build-help-corpus.mjs';
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '');

// Every wrangler config that bundles src/index.ts: the generated assistant JSON is build output (Ruling WA-GEN-1), so a deploy from a fresh checkout must build it.
const configs = [root, join(root, 'deploy', 'white-label')].flatMap((dir) =>
  readdirSync(dir).filter((f) => /^wrangler.*\.jsonc$/.test(f)).map((f) => join(dir, f)),
).filter((f) => /"main"\s*:\s*"[^"]*src\/index\.ts"/.test(strip(readFileSync(f, 'utf8'))));

it('finds the root config and the white-label template', () => {
  expect(configs.map((f) => f.slice(root.length + 1)).sort()).toEqual(expect.arrayContaining(['deploy/white-label/wrangler.template.jsonc', 'wrangler.jsonc']));
});

it.each(configs.map((f) => [f.slice(root.length + 1), f]))('%s builds the help corpus before bundling', (_n, f) => {
  expect(JSON.parse(strip(readFileSync(f!, 'utf8'))).build?.command).toBe(BUILD);
});

it('the command is repo-root relative, so deploy.sh must run wrangler from the repo root', () => {
  const sh = readFileSync(join(root, 'deploy/white-label/deploy.sh'), 'utf8');
  expect(sh.indexOf('cd "$(dirname "$0")/../.."')).toBeGreaterThan(-1);
  expect(sh.indexOf('cd "$(dirname "$0")/../.."')).toBeLessThan(sh.indexOf('wrangler deploy'));
});
