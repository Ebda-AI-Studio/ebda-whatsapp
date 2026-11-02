import { expect, it } from 'vitest';
import { findMatches } from './helpers/grep';

// Ruling PERF-TIMEOUTS-1: every third-party call goes through fetchWithTimeout (src/core/net/fetch-with-timeout.ts), so none can hang on a
// stalled upstream. A bare global `fetch(` or a `?? fetch` / `= fetch` value reference is a call that bypasses it. `x.fetch(...)` (service bindings,
// assets, Durable Object stubs, the DO's own `fetch` method) is not a third-party call and is not matched.
const NOT_COMMENT = '^(?!\\s*(//|\\*|/\\*))';
const RAW_CALL = new RegExp(`${NOT_COMMENT}.*?(^|[^.\\w$])fetch\\(`);
const RAW_REF = new RegExp(`${NOT_COMMENT}.*?(\\?\\?|\\|\\||=)\\s*fetch\\b(?!\\w)`);
const HELPER = /^src\/core\/net\/fetch-with-timeout\.ts:/;
const code = (hit: string) => !/\.test\.tsx?:/.test(hit);

it('no raw global fetch under src/ outside the timeout helper', () => {
  const hits = [...findMatches(RAW_CALL, 'src'), ...findMatches(RAW_REF, 'src')].filter((h) => !HELPER.test(h) && code(h));
  // the Durable Object's own `override async fetch(request)` method definition is not a call
  expect(hits.filter((h) => h !== 'src/core/workspace-do.ts:1709')).toEqual([]);
});

it('a comment mentioning fetch() is not a call', () => {
  expect(RAW_CALL.test('  // passed-through fetch() responses')).toBe(false);
});

it('the matcher catches the bare forms and spares the method forms (negative control)', () => {
  for (const bad of ['await fetch(url)', 'res = fetch(url, init)', 'const f = cfg.fetcher ?? fetch;', '(url, init) => fetch(url, init)']) {
    expect(RAW_CALL.test(bad) || RAW_REF.test(bad), bad).toBe(true);
  }
  for (const ok of ['c.env.ASSETS.fetch(req)', 'ws.fetch(req)', 'fetcher?: typeof fetch', 'fetchWithTimeout(url, init, o)', 'override async fetch(request: Request)']) {
    expect(RAW_CALL.test(ok) && !/override async/.test(ok) || RAW_REF.test(ok), ok).toBe(false);
  }
});
