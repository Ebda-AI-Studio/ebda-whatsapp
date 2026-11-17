/**
 * The capability coverage guard (plan 4 Task E0, SL-SCOPE-1): every live, non-forbidden capability must be reachable by the assistant, either through a tool whose
 * `capabilityId` it is, or as a documented deep link (`DEEP_LINK_ONLY`), or owned by the engine itself. A capability that flips to live without one is a new
 * violation and fails CI; the existing gaps sit in a shrink-only baseline (`capabilities/baselines/assistant-tools.json`) that the capability-ratchet workflow
 * forbids growing.
 */
import type { Violation } from '../../../foundation/capability';
import type { RegistryCap, ToolSpec } from '../../../foundation/smart-layer/types';

export function uncovered(caps: Iterable<Pick<RegistryCap, 'id' | 'status' | 'policy'>>, tools: readonly Pick<ToolSpec, 'capabilityId'>[], deepLinkOnly: Readonly<Record<string, unknown>>, ownedElsewhere: Readonly<Record<string, string>>): string[] {
  const covered = new Set(tools.map((t) => t.capabilityId));
  return [...caps]
    .filter((c) => c.status === 'live' && c.policy !== 'forbidden' && !covered.has(c.id) && !(c.id in deepLinkOnly) && !(c.id in ownedElsewhere))
    .map((c) => c.id)
    .sort();
}

export const toViolations = (ids: string[]): Violation[] => ids.map((id) => ({ rule: 'capability-without-tool', key: id, message: `${id} is live and not forbidden but the assistant has no tool for it (add one, or list it in deep-link-only.ts with the reason)` }) as Violation);
