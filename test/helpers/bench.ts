/**
 * Bench budgets that are FIXED, not runner-sized (M-176). A wall-clock budget in milliseconds measures the machine: the nightly job used to pass a 10x "runner-sized"
 * budget, which certifies nothing. Instead every bench measures a baseline on the SAME machine in the SAME run (the mean of 200 trivial authenticated calls through
 * the same Worker -> Hono -> auth path) and each budget is a FIXED MULTIPLE of it. A slower runner moves the baseline and the measurement together; a regression (a lost
 * index, an N+1) moves only the measurement. The multiples were set at about 3x the ratios measured locally on 2026-10-27 (reads 3-4x, send-enqueue 5-6x).
 * The absolute product budget (150 ms p95) is certified only where the machine is known: `node scripts/bench-local.mjs` sets BENCH_ABSOLUTE_MS.
 */
export const BUDGET_RATIO = { read: 12, send: 20 } as const;

export const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
export const p95Of = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)]!;

/** The baseline (milliseconds): the mean of `samples` trivial calls. Never zero, so a clock that did not advance cannot make every budget 0. */
export async function baselineMs(call: () => Promise<number>, samples = 200): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < samples; i++) xs.push(await call());
  return Math.max(0.25, mean(xs));
}

/** The failure message when `p95` is over `ratio` x `baseline`; null when within budget. Also checks the absolute ceiling when one is given (a known machine only). */
export function overBudget(name: string, p95: number, baseline: number, ratio: number, absoluteMs?: string | number): string | null {
  if (p95 > ratio * baseline) return `${name}: p95 ${p95.toFixed(2)} ms is over ${ratio} x the baseline ${baseline.toFixed(2)} ms (budget ${(ratio * baseline).toFixed(2)} ms)`;
  const abs = Number(absoluteMs);
  if (absoluteMs !== undefined && absoluteMs !== '' && Number.isFinite(abs) && p95 > abs) return `${name}: p95 ${p95.toFixed(2)} ms is over the absolute product budget ${abs} ms`;
  return null;
}
