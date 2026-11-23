import { describe, expect, it } from 'vitest';
import { STRINGS } from './i18n';

describe('ids inside operator sentences are bidi-isolated', () => {
  it.each(['ar', 'en'] as const)('%s: workspace ids and actors are wrapped in an LTR isolate', (lang) => {
    const t = STRINGS[lang];
    const id = '1bb14d0e-aaaa-bbbb-cccc-000000000001';
    for (const s of [t.opAssistant.wsCurrent(id, 'x'), t.opAssistant.confirmWs(id, 'x'), t.opBy(id), t.opRequestedBy(id)]) expect(s).toContain(`⁦${id}⁩`);
  });
});
