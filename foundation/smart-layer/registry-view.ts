/** The only file that knows the capability registry's field names (pr 71, `../capability`). Everything else reads `RegistryView`. */
import type { Capability } from '../capability';
import type { RegistryCap, RegistryView } from './types';

export function toRegistryView(entries: Capability[]): RegistryView {
  const caps = new Map<string, RegistryCap>();
  const byPath = new Map<string, RegistryCap>();
  for (const c of entries) {
    const cap: RegistryCap = {
      id: c.id,
      version: c.version,
      status: c.status,
      policy: c.policy,
      undo: c.undo.class,
      title: { ar: c.titleAr, en: c.titleEn },
      appPaths: c.screens.filter((s) => s.startsWith('/')),
      // The schema has no per-screen button labels: the titles stand in until it gains an optional `uiLabels` field.
      uiLabels: { ar: [c.titleAr], en: [c.titleEn] },
      helpArticle: c.helpArticle,
      examples: [...c.questions.ar, ...c.questions.en],
      area: c.area,
    };
    caps.set(cap.id, cap);
    for (const p of cap.appPaths) if (!byPath.has(p)) byPath.set(p, cap);
  }
  return { caps, byAppPath: (p) => byPath.get(p) };
}
