import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module
import { evaluateDrift, parseTag } from '../scripts/foundation-drift-lib.mjs';

type Out = { status: 'ok' | 'fail' | 'unknown'; behind: number; message: string };
const run = (input: unknown) => (evaluateDrift as (i: unknown) => Out)(input);
const now = new Date('2026-11-24T12:00:00Z');
const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

describe('foundation drift rule', () => {
  it('the latest tag, or one release behind at any age, is fine', () => {
    expect(run({ lockTag: 'v0.4.3', tags: [{ name: 'v0.4.3', date: day(30) }], now }).status).toBe('ok');
    expect(run({ lockTag: 'v0.4.1', tags: [{ name: 'v0.4.2', date: day(90) }, { name: 'v0.4.1', date: day(99) }], now }).status).toBe('ok');
  });
  it('two or more behind is fine for 7 days counted from the SECOND newer release', () => {
    const tags = [{ name: 'v0.4.3', date: day(6.5) }, { name: 'v0.4.2', date: day(20) }, { name: 'v0.4.1', date: day(40) }];
    expect(run({ lockTag: 'v0.4.1', tags, now })).toMatchObject({ status: 'ok', behind: 2 });
  });
  it('two or more behind for longer than 7 days fails and names the way out', () => {
    const tags = [{ name: 'v0.4.3', date: day(8) }, { name: 'v0.4.2', date: day(20) }, { name: 'v0.4.1', date: day(40) }];
    const r = run({ lockTag: 'v0.4.1', tags, now });
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/2 releases behind v0\.4\.3/);
  });
  it('the age is measured from the second newer release, not the first (a long-stale first one alone does not fail)', () => {
    const tags = [{ name: 'v0.4.2', date: day(30) }, { name: 'v0.4.3', date: day(2) }];
    expect(run({ lockTag: 'v0.4.1', tags, now }).status).toBe('ok');
  });
  it('ignores non-semver and older tags; a lock ahead of every tag is fine', () => {
    expect(run({ lockTag: 'v0.4.2', tags: [{ name: 'final-before-ebda', date: day(99) }, { name: 'v0.3.0', date: day(99) }], now }).status).toBe('ok');
    expect(run({ lockTag: 'v9.0.0', tags: [{ name: 'v0.4.3', date: day(99) }], now }).behind).toBe(0);
  });
  it('an unreadable lock tag or release date is unknown, never a silent pass or a false fail', () => {
    expect(run({ lockTag: 'main', tags: [], now }).status).toBe('unknown');
    expect(run({ lockTag: 'v0.4.1', tags: [{ name: 'v0.4.2', date: day(1) }, { name: 'v0.4.3', date: 'not-a-date' }], now }).status).toBe('unknown');
  });
  it('parses vMAJOR.MINOR.PATCH only', () => {
    expect((parseTag as (t: string) => number[] | null)('v1.22.3')).toEqual([1, 22, 3]);
    expect((parseTag as (t: string) => number[] | null)('v1.2')).toBeNull();
  });
});
