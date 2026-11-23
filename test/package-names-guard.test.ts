import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// Ahmad 2026-11-19: no merchant-facing Chat text may name a package Starter / Growth / Pro (they collide with the Store's plan names). This reads the places
// that show a Chat package name: the help guides and the docs site (the Store vendors them), the capability registry, the web strings and sample data.
const ROOT = join(import.meta.dirname, '..');
const TIER = /\b(Starter|Growth|Pro)\b/;
const ALLOW = /starter template|Starter templates|starter-on-connect|starter set/i; // the starter TEMPLATE set is not a package
function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) ? [p] : []; });
}

it('no help guide, docs page, capability, web string or sample names a Chat package Starter / Growth / Pro', () => {
  const targets = [
    ...files(join(ROOT, 'docs/help'), /\.md$/), ...files(join(ROOT, 'docs/site'), /\.mdx?$/), ...files(join(ROOT, 'capabilities'), /\.json$/),
    ...files(join(ROOT, 'web/src/data'), /\.ts$/).filter((f) => !/\.test\./.test(f)), join(ROOT, 'web/src/i18n.ts'),
  ];
  const hits = targets.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f: relative(ROOT, f), i: i + 1, l })).filter((x) => TIER.test(x.l) && !ALLOW.test(x.l)).map((x) => `${x.f}:${x.i}`));
  expect(hits).toEqual([]);
});
