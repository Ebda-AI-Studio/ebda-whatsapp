import { expect, it } from 'vitest';
import { takeApiToken } from '../src/core/api-rate';
import { overBudget, unthrottleApiForBench } from './helpers/bench';

// The nightly speed benches failed 3 days running on 429s from the F4 limiter (burst 100) before they timed anything. These two tests keep the fix honest:
// a bench is unthrottled for its own test only, and the budget still fails on a slow path.
it('unthrottleApiForBench lifts the workspace limit for this test (500 calls, burst is 100)', () => {
  unthrottleApiForBench();
  for (let i = 0; i < 500; i++) expect(takeApiToken('ws-bench-unthrottle', null)).toBe(0);
});
it('the next test is limited again (the lift did not leak)', () => {
  let refused = 0;
  for (let i = 0; i < 500; i++) if (takeApiToken('ws-bench-leak', null) > 0) refused++;
  expect(refused).toBeGreaterThan(300);
});
it('overBudget still flags a path 2x over its budget and passes one inside it', () => {
  expect(overBudget('list', 24, 1, 12)).toMatch(/over 12 x the baseline/);
  expect(overBudget('list', 6, 1, 12)).toBeNull();
});
