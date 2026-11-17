/** Segment write tool (wave 1): create a saved audience, or change an existing one by name. Deleting one is a confirm-class action (wave 2). */
import { z } from 'zod';
import { segmentCriteria, type SegmentDto } from '../../api/contract';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import { ToolInputError, pickByName, row, writeTool, type Kit } from './write';

const args = z.object({
  name: z.string().trim().min(1).max(60).describe('the segment name: an existing one is changed, a new one is created'),
  criteria: segmentCriteria.describe('who is in it: tags, last-message dates, has ordered, or everyone'),
  restoring: z.literal(true).optional().describe('set only by Undo of a delete: refuses when a segment with this name exists now, instead of changing it'),
}).strict();

const deleteArgs = z.object({ segment: z.string().trim().min(1).max(60).describe('the segment name') }).strict();

export function segmentTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'segment_delete', capabilityId: 'segments.manage', policy: 'confirm', undo: 'compensating', deletes: true,
      description: 'Delete a saved segment. Campaigns already made from it keep their audience. The merchant confirms with the button; the segment can be created again from the same filter.',
      args: deleteArgs,
      read: async (api, _c, a) => {
        const list = (await api.get('/segments')) as { items?: SegmentDto[] };
        const seg = pickByName(list.items ?? [], (x) => x.name, a.segment);
        return { id: seg.id, name: seg.name, criteria: seg.criteria };
      },
      plan: (_a, s) => ({
        summary: { ar: `مسح شريحة "${s.name}"`, en: `Delete the segment "${s.name}"` },
        rows: [row('الشريحة', 'Segment', s.name, undefined), row('الفلتر', 'Filter', JSON.stringify(s.criteria), undefined)],
        request: { method: 'DELETE', path: `/segments/${s.id}` },
        restore: { tool: 'segment_upsert', args: { name: s.name, criteria: s.criteria, restoring: true } },
      }),
    }, kit),
    writeTool({
      name: 'segment_upsert', capabilityId: 'segments.manage', policy: 'preview', undo: 'compensating',
      description: 'Create a saved audience (segment), or change the filter of an existing one with the same name. The preview shows how many people would receive a marketing message and who is left out and why.',
      args,
      read: async (api, _c, a) => {
        const list = (await api.get('/segments')) as { items?: SegmentDto[] };
        const have = (list.items ?? []).find((s) => s.name.trim().toLowerCase() === a.name.trim().toLowerCase()) ?? null;
        const audience = (await api.ask('/segments/preview', { criteria: a.criteria })) as { count: number; excluded: { optedOut: number; noConsent: number } };
        return { id: have?.id ?? null, criteria: have?.criteria ?? null, audience };
      },
      plan: (a, s) => {
        // Undo of a delete must put the segment BACK, never write over one made since (same name, any filter): it refuses (writes nothing).
        if (a.restoring && s.id !== null) throw new ToolInputError('name_taken'); // the engine answers the Undo press with `failed` and writes nothing; the cards say why
        if (s.id !== null && JSON.stringify(s.criteria) === JSON.stringify(a.criteria)) throw new ToolInputError('no_change');
        const who = (c: unknown) => (c === null ? '-' : JSON.stringify(c));
        return {
          summary: s.id === null ? { ar: `إنشاء شريحة "${a.name}"`, en: `Create the segment "${a.name}"` } : { ar: `تعديل شريحة "${a.name}"`, en: `Change the segment "${a.name}"` },
          rows: [
            row('الفلتر', 'Filter', s.id === null ? undefined : who(s.criteria), who(a.criteria)),
            row('هيوصل لكام واحد', 'People it would reach', undefined, String(s.audience.count)),
            row('مستبعدين (انسحبوا / مفيش موافقة)', 'Left out (opted out / no consent)', undefined, `${s.audience.excluded.optedOut} / ${s.audience.excluded.noConsent}`),
          ],
          request: s.id === null ? { method: 'POST', path: '/segments', body: { name: a.name, criteria: a.criteria } } : { method: 'PUT', path: `/segments/${s.id}`, body: { criteria: a.criteria } },
          restore: s.id !== null && s.criteria ? { name: a.name, criteria: s.criteria } : { tool: 'segment_delete', args: { segment: a.name } },
        };
      },
      // Whether people were added to or left the audience while the merchant looked at the card is a reason to look again.
      fingerprint: (s) => ({ id: s.id, criteria: s.criteria, count: s.audience.count }),
    }, kit),
  ];
}
