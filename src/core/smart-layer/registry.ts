/** The capability registry as the engine reads it. The product passes `assistant/registry.generated.json` (built by `scripts/build-help-corpus.mjs` through the engine's own `toRegistryView`; a test fails when it is stale). */
import type { RegistryCap, RegistryView } from '../../../foundation/smart-layer/types';

export function viewOf(caps: readonly RegistryCap[]): RegistryView {
  const byId = new Map(caps.map((c) => [c.id, c]));
  const byPath = new Map<string, RegistryCap>();
  for (const c of caps) for (const p of c.appPaths) if (!byPath.has(p)) byPath.set(p, c);
  return { caps: byId, byAppPath: (p) => byPath.get(p) };
}
