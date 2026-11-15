/** Template tools: the starter-set install (wave 2). The writer tools over the templates service arrive in D1. */
import { z } from 'zod';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import { row, writeTool, type Kit } from './write';

export function templateTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'templates_install_defaults', capabilityId: 'templates.install-defaults', policy: 'confirm', undo: 'irreversible',
      description: 'Submit the starter set of message templates to Meta for approval. Each one is sent to Meta and cannot be taken back, so the merchant confirms with the button.',
      args: z.object({}).strict(),
      read: async (api) => ({ names: ((await api.get('/templates')) as { items?: Array<{ name: string; language: string }> }).items?.map((t) => `${t.name}/${t.language}`).sort() ?? [] }),
      plan: (_a, s) => ({
        summary: { ar: 'تقديم قوالب البداية لـ Meta', en: 'Submit the starter templates to Meta' },
        rows: [row('قوالب موجودة عندك دلوقتي', 'Templates you already have', undefined, String(s.names.length)), row('اللي هيحصل', 'What happens', undefined, 'القوالب الناقصة بتتبعت لـ Meta للمراجعة / the missing ones are sent to Meta for review')],
        request: { method: 'POST', path: '/templates/install-defaults' },
      }),
    }, kit),
  ];
}
