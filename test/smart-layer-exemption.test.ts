import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// INSTAPAY-AUTO-1.11: the proof reader's Smart Layer exemption is TEMPORARY and exactly one file/function. The guard schema has no expiry field, so a test checks it here.
const cfg = JSON.parse(readFileSync(new URL('../capabilities/guard.config.json', import.meta.url), 'utf8')) as {
  smartLayerPaths: string[]; smartLayerExemptions?: Array<{ path: string; function: string; reason: string; expires: string; followUp: string; ruling: string }>;
};
const ex = cfg.smartLayerExemptions ?? [];
/** The Smart Layer itself (engine + adapter), where model calls belong. These two names only: any other entry, a directory such as `src/` included, needs a full exemption record. */
export const SMART_LAYER_DIRS = ['foundation/smart-layer/', 'src/core/smart-layer/'];
/** The record check, as a function so a test can feed it a bad config. */
export const unrecordedPaths = (paths: string[], records: Array<{ path: string }>) => paths.filter((p) => !SMART_LAYER_DIRS.includes(p) && !records.some((e) => e.path === p));

it('every smartLayerPaths entry has a narrow exemption record (file, function, reason, expiry, follow-up, ruling) and nothing else is exempt', () => {
  expect(cfg.smartLayerPaths.filter((p) => !SMART_LAYER_DIRS.includes(p)).sort()).toEqual(ex.map((e) => e.path).sort());
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

it('only the two smart-layer directories skip the record: `src/` or any other prefix fails', () => {
  for (const bad of ['src/', 'src/core/', 'foundation/', 'src/core/smart-layer', 'src/core/smart-layer/../', 'src/routes/']) expect(unrecordedPaths([...SMART_LAYER_DIRS, bad], []), bad).toEqual([bad]);
  expect(unrecordedPaths(SMART_LAYER_DIRS, [])).toEqual([]);
});
