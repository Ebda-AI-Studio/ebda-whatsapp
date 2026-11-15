/** Contact write tools (wave 1): tags and display name. The contact is found from the name the merchant typed; a phone number is never an argument. */
import { z } from 'zod';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import type { CallApi } from './read.tools';
import { ToolInputError, findContact, row, writeTool } from './write';

const customer = z.string().trim().min(1).max(100).describe("the customer's name as the merchant wrote it");
const tagsArgs = z.object({ customer, tags: z.array(z.string().trim().min(1).max(32)).max(10).describe('the full list of tags the customer should have afterwards') }).strict();
const renameArgs = z.object({ customer, name: z.string().trim().min(1).max(100).describe('the new name') }).strict();

export function contactTools(callApi: CallApi): ToolSpec[] {
  return [
    writeTool({
      name: 'contact_tags_set', capabilityId: 'contacts.tags-edit', policy: 'preview', undo: 'reversible',
      description: "Set the tags on a customer (replaces the list). Give the customer's name. Shows a preview first.",
      args: tagsArgs,
      read: async (api, _c, a) => { const c = await findContact(api, a.customer); return { waId: c.waId, name: c.name, tags: [...(c.tags ?? [])].sort() }; },
      // The etag leaves the phone number out: it is only a comparison value, the draft never carries it.
      fingerprint: (s) => ({ name: s.name, tags: s.tags }),
      plan: (a, s) => {
        const next = [...new Set(a.tags.map((t) => t.toLowerCase()))];
        return {
          summary: { ar: `تعديل تاجات ${s.name ?? a.customer}`, en: `Change the tags on ${s.name ?? a.customer}` },
          rows: [row('التاجات', 'Tags', s.tags.join('، ') || '-', next.join('، ') || '-')],
          request: { method: 'PUT', path: `/contacts/${s.waId}/tags`, body: { tags: next } },
          restore: { customer: s.name ?? a.customer, tags: s.tags },
        };
      },
    }, callApi),
    writeTool({
      name: 'contact_rename', capabilityId: 'contacts.rename', policy: 'preview', undo: 'reversible',
      description: "Change the name the merchant sees for a customer. Give the customer's current name and the new one.",
      args: renameArgs,
      read: async (api, _c, a) => { const c = await findContact(api, a.customer); return { waId: c.waId, name: c.name }; },
      fingerprint: (s) => ({ name: s.name }),
      plan: (a, s) => {
        if (s.name === a.name) throw new ToolInputError('no_change');
        return {
          summary: { ar: `تغيير اسم العميل ${s.name ?? ''}`, en: `Rename ${s.name ?? 'the customer'}` },
          rows: [row('الاسم', 'Name', s.name ?? '-', a.name, 'merchant')],
          request: { method: 'PATCH', path: `/contacts/${s.waId}`, body: { name: a.name } },
          restore: { customer: a.name, name: s.name ?? a.customer },
        };
      },
    }, callApi),
  ];
}
