import { expect, it } from 'vitest';
import { BUDGET_RATIO, baselineMs, overBudget } from './helpers/bench';

// M-176: the bench budget is a fixed multiple of a same-run baseline, so it does not depend on how fast the runner is.
it('the same code on a runner 10x slower passes: the baseline and the measurement scale together', () => {
  expect(overBudget('list', 4, 1, BUDGET_RATIO.read)).toBeNull();
  expect(overBudget('list', 40, 10, BUDGET_RATIO.read)).toBeNull();
});
it('a real regression (5x slower than the baseline allows) fails on a fast runner and on a slow one', () => {
  expect(overBudget('list', 4 * 5, 1, BUDGET_RATIO.read)).toContain('over 12 x the baseline');
  expect(overBudget('list', 40 * 5, 10, BUDGET_RATIO.read)).toContain('over 12 x the baseline');
});
it('an absolute ceiling applies only when one is given (a known machine), and a coarse clock cannot make the budget zero', async () => {
  expect(overBudget('list', 200, 100, BUDGET_RATIO.read)).toBeNull();
  expect(overBudget('list', 200, 100, BUDGET_RATIO.read, '150')).toContain('absolute product budget 150');
  expect(overBudget('list', 1, 1, BUDGET_RATIO.read, '')).toBeNull();
  expect(await baselineMs(async () => 0, 10)).toBe(0.25);
});
