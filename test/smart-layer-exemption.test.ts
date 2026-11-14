import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// INSTAPAY-AUTO-1.11: the proof reader's Smart Layer exemption is TEMPORARY and exactly one file/function. The guard schema has no expiry field, so a test checks it here.
const cfg = JSON.parse(readFileSync(new URL('../capabilities/guard.config.json', import.meta.url), 'utf8')) as {
  smartLayerPaths: string[]; smartLayerExemptions?: Array<{ path: string; function: string; reason: string; expires: string; followUp: string; ruling: string }>;
};
const ex = cfg.smartLayerExemptions ?? [];

it('every smartLayerPaths entry has a narrow exemption record (file, function, reason, expiry, follow-up, ruling) and nothing else is exempt', () => {
  // A directory entry is the Smart Layer itself (engine + adapter), where model calls belong; only an exact FILE outside it is a temporary exemption.
  expect(cfg.smartLayerPaths.filter((p) => !p.endsWith('/')).sort()).toEqual(ex.map((e) => e.path).sort());
  for (const e of ex) {
    expect(e.path, 'an exact file, not a directory').toMatch(/\.ts$/);
    expect(readFileSync(new URL(`../${e.path}`, import.meta.url), 'utf8')).toContain(`function ${e.function}`);
    for (const k of ['reason', 'followUp', 'ruling'] as const) expect(e[k].length, k).toBeGreaterThan(10);
    expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(new URL(`../docs/rulings/${e.ruling.replace(/\.\d+$/, '')}.md`, import.meta.url), 'utf8')).toContain(e.ruling);
  }
});
it('an expired exemption fails the build until it is removed or renewed by a new ruling', () => {
  for (const e of ex) expect(Date.now() <= Date.parse(`${e.expires}T23:59:59Z`), `${e.path} exemption expired ${e.expires}: ${e.followUp}`).toBe(true);
});
