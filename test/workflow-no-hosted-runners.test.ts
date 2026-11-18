/**
 * Ahmad 2026-11-16: NEVER a GitHub-hosted runner (no hosted minutes). Every `runs-on` in .github/workflows resolves to a Mac pool label:
 * a repo variable with a Mac-label fallback, never a hosted image name. A leftover hosted fallback silently takes over when the variable is unset.
 * The detector is tested on samples (so it cannot rot into a vacuous pass) and then run over the real workflow files.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = new URL('../.github/workflows/', import.meta.url);
/** GitHub-hosted image names: ubuntu-*, windows-*, macos-* (the self-hosted macOS runners are selected by the ebda-mac labels, never by these). */
const HOSTED = /\b(ubuntu|windows|macos)-(latest|\d[\w.-]*)\b/i;

/** The `runs-on:` lines of a workflow text that name a hosted image. */
export function hostedRunsOn(text: string): string[] {
  return text
    .split('\n')
    .filter(l => /^\s*runs-on:/.test(l) && HOSTED.test(l))
    .map(l => l.trim());
}

describe('hostedRunsOn (the detector)', () => {
  it('flags a hosted fallback inside a runs-on expression and a bare hosted label', () => {
    expect(hostedRunsOn("    runs-on: ${{ fromJSON(vars.EBDA_RUNS_ON || '\"ubuntu-24.04\"') }}")).toHaveLength(1);
    expect(hostedRunsOn('    runs-on: ubuntu-latest')).toHaveLength(1);
    expect(hostedRunsOn('    runs-on: macos-14')).toHaveLength(1);
    expect(hostedRunsOn('    runs-on: windows-2022')).toHaveLength(1);
  });
  it('passes a Mac fallback, ignores comments and non-runs-on lines', () => {
    expect(hostedRunsOn("    runs-on: ${{ fromJSON(vars.EBDA_RUNS_ON || '[\"ebda-mac-light\"]') }}")).toEqual([]);
    expect(hostedRunsOn('    runs-on: [self-hosted, ebda-mac]')).toEqual([]);
    expect(hostedRunsOn('    # runs-on: ubuntu-latest was removed')).toEqual([]);
    expect(hostedRunsOn('  - run: echo ubuntu-latest')).toEqual([]);
  });
});

describe('the real workflows', () => {
  const files = readdirSync(DIR).filter(f => /\.ya?ml$/.test(f));
  it('reads the workflow files and finds runs-on lines (the walk is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(3);
    const n = files.reduce((a, f) => a + (readFileSync(new URL(f, DIR), 'utf8').match(/^\s*runs-on:/gm) ?? []).length, 0);
    expect(n).toBeGreaterThan(8);
  });
  it.each(files)('%s has no GitHub-hosted runs-on', f => {
    expect(hostedRunsOn(readFileSync(new URL(f, DIR), 'utf8')), 'a hosted runner name in runs-on').toEqual([]);
  });
});
