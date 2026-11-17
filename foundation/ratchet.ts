import type { Violation } from './capability';

export const violationId = (v: Violation): string => `${v.rule}|${v.key}`;

export function applyBaseline(violations: Violation[], baseline: string[]): { fresh: Violation[]; tolerated: Violation[]; stale: string[] } {
  const base = new Set(baseline);
  const current = new Set(violations.map(violationId));
  return {
    fresh: violations.filter((v) => !base.has(violationId(v))),
    tolerated: violations.filter((v) => base.has(violationId(v))),
    stale: baseline.filter((id) => !current.has(id)),
  };
}

/** Ids in the PR baseline that the base baseline lacks: a PR may never grow a baseline. */
export function baselineGrowth(pr: string[], base: string[]): string[] {
  const b = new Set(base);
  return pr.filter((id) => !b.has(id));
}

export function guardOutcome(r: ReturnType<typeof applyBaseline>): { failures: string[]; warnings: string[] } {
  return {
    failures: [
      ...r.fresh.map((v) => `new violation ${violationId(v)}: ${v.message}`),
      ...r.stale.map((id) => `stale baseline id ${id}: fixed, remove it from the baseline in this PR`),
    ],
    warnings: r.tolerated.map((v) => `::warning::baselined ${violationId(v)}: ${v.message}`),
  };
}
