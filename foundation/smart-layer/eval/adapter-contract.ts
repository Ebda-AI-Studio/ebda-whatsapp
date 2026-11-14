/**
 * Adapter contract check: run it in every product's test suite AND at boot (fail loud). It proves the tool list agrees with the capability
 * registry, which is the source of truth (spec 6.8): drift here means a gate was weakened. Returns human-readable problems; empty = aligned.
 */
import { strongerPolicy, strongerUndo } from '../exec/policy';
import type { SmartLayerAdapter } from '../types';

export function checkAdapterContract(a: SmartLayerAdapter): string[] {
  const problems: string[] = [];
  const reg = a.registry();
  const seen = new Set<string>();
  for (const t of a.tools()) {
    if (seen.has(t.name)) problems.push(`${t.name}: duplicate tool name`);
    seen.add(t.name);
    const cap = reg.caps.get(t.capabilityId);
    if (!cap) { problems.push(`${t.name}: capability ${t.capabilityId} is not in the registry`); continue; }
    if (cap.status !== 'live') problems.push(`${t.name}: capability ${t.capabilityId} is not live (${cap.status})`);
    if (cap.policy === 'forbidden') problems.push(`${t.name}: capability ${t.capabilityId} is forbidden, it must have no tool`);
    else if (strongerPolicy(t.policy, cap.policy) !== t.policy) problems.push(`${t.name}: tool policy ${t.policy} is weaker than registry ${cap.policy}`);
    if (t.policy !== 'free' && strongerUndo(t.undo, cap.undo) !== t.undo) problems.push(`${t.name}: tool undo ${t.undo} is weaker than registry ${cap.undo}`);
    if (t.policy === 'free' && !t.read) problems.push(`${t.name}: free tool needs read`);
    if (t.policy !== 'free' && (!t.preview || !t.apply)) problems.push(`${t.name}: non-free tool needs preview and apply`);
  }
  return problems;
}
