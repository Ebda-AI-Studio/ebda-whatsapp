/**
 * Shared plumbing for the capability guard tests (workers and node projects alike: files come in through import.meta.glob, no fs).
 * Load the registry and a shrink-only baseline, run `applyBaseline`, report tolerated debt as ::warning:: lines, fail on a new violation
 * or a stale baseline id.
 */
import type { Capability, GuardConfig, Violation } from '../../foundation/capability';
import { checkRegistry } from '../../foundation/capability-registry';
import { applyBaseline, guardOutcome, violationId } from '../../foundation/ratchet';
import cfgJson from '../../capabilities/guard.config.json';

export type BaselineName = 'registry' | 'coverage' | 'superadmin' | 'bypass' | 'help';

export const guardConfig = cfgJson as GuardConfig;

const registryFiles = import.meta.glob('../../capabilities/*.capability.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const baselineFiles = import.meta.glob('../../capabilities/baselines/*.json', { eager: true, import: 'default' }) as Record<string, { ids: string[] }>;

export const loadRegistry = (cfg: GuardConfig = guardConfig): { entries: Capability[]; violations: Violation[] } =>
  checkRegistry(Object.entries(registryFiles).map(([p, json]) => ({ name: p.split('/').pop()!, json })).sort((a, b) => a.name.localeCompare(b.name)), cfg);

export const loadBaseline = (name: BaselineName): string[] => baselineFiles[`../../capabilities/baselines/${name}.json`]?.ids ?? [];

export function judge(name: BaselineName, violations: Violation[]): { failures: string[]; tolerated: number } {
  const r = applyBaseline(violations, loadBaseline(name));
  const { failures, warnings } = guardOutcome(r);
  for (const w of warnings.slice(0, 10)) console.warn(w);
  if (warnings.length) console.warn(`::warning::${name} baseline: ${warnings.length} tolerated violation(s), shrink-only (${warnings.length > 10 ? 'first 10 shown' : 'all shown'})`);
  return { failures, tolerated: r.tolerated.length };
}

export const idsOf = (vs: Violation[]): string[] => vs.map(violationId);
