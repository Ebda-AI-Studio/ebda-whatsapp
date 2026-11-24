import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs module
import { checkDrift, evaluateDrift, parseTag } from '../scripts/foundation-drift-lib.mjs';

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

// ---- the GitHub side: every read is bounded, and the date is the annotated tag's ----
type Check = (o: Record<string, unknown>) => Promise<{ status: string; message: string }>;
const check = checkDrift as unknown as Check;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const fakeGitHub = (annotated: Record<string, string>, commitDates: Record<string, string>) => async (url: string) => {
  const path = url.replace('https://api.github.com/repos/o/r/', '');
  if (path.startsWith('tags?')) return json([{ name: 'v0.4.3', commit: { sha: 'c3' } }, { name: 'v0.4.2', commit: { sha: 'c2' } }, { name: 'v0.4.1', commit: { sha: 'c1' } }]);
  const tag = /^git\/ref\/tags\/(.+)$/.exec(path)?.[1];
  if (tag) return json({ object: annotated[tag] ? { type: 'tag', sha: `t-${tag}` } : { type: 'commit', sha: 'x' } });
  const t = /^git\/tags\/t-(.+)$/.exec(path)?.[1];
  if (t) return json({ tagger: { date: annotated[t] } });
  const c = /^commits\/(.+)$/.exec(path)?.[1];
  if (c) return json({ commit: { committer: { date: commitDates[c] } } });
  return json({}, false);
};

describe('bounded GitHub reads', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  it('a fetch that never resolves ends in skipped within the budget (warn and pass), not a hang', async () => {
    const never = () => new Promise(() => {});
    const t0 = Date.now();
    const r = await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: never, now, callMs: 40, budgetMs: 120 });
    expect(r.status).toBe('skipped');
    expect(r.message).toMatch(/timed out|budget/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
  it('a fetch that answers slowly on every call stops at the overall budget', async () => {
    const slow = () => new Promise(res => setTimeout(() => res(json([])), 60));
    const r = await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: slow, now, callMs: 100, budgetMs: 150 });
    expect(['ok', 'skipped']).toContain(r.status);
  });
  it('an HTTP error is skipped, never a failure', async () => {
    const r = await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: async () => json({}, false), now });
    expect(r.status).toBe('skipped');
  });
  it('the clock starts at the annotated tag date, not the (earlier) commit date', async () => {
    // v0.4.3 was COMMITTED 10 days ago but TAGGED 2 days ago: only 2 days old for the rule -> ok
    const gh = fakeGitHub({ 'v0.4.3': day(2), 'v0.4.2': day(20) }, { c3: day(10), c2: day(20) });
    expect((await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: gh, now })).status).toBe('ok');
    // tagged 9 days ago -> fail
    const old = fakeGitHub({ 'v0.4.3': day(9), 'v0.4.2': day(20) }, { c3: day(10), c2: day(20) });
    expect((await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: old, now })).status).toBe('fail');
  });
  it('a lightweight tag falls back to its commit date', async () => {
    const gh = fakeGitHub({}, { c3: day(9), c2: day(20) });
    expect((await check({ lockTag: 'v0.4.1', repo: 'o/r', fetchImpl: gh, now })).status).toBe('fail');
  });
});
