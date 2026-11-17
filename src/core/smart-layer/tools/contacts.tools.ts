/** Contact write tools (wave 1): tags and display name. The contact is found from the name the merchant typed; a phone number is never an argument. */
import { z } from 'zod';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import { ToolInputError, findContact, row, writeTool, type Kit } from './write';

const customer = z.string().trim().min(1).max(100).describe("the customer's name as the merchant wrote it");
const tagsArgs = z.object({ customer, tags: z.array(z.string().trim().min(1).max(32)).max(10).describe('the full list of tags the customer should have afterwards') }).strict();
const renameArgs = z.object({ customer, name: z.string().trim().min(1).max(100).describe('the new name') }).strict();

const eraseArgs = z.object({ customer }).strict();
const mergeArgs = z.object({ from: customer.describe('the customer to fold away (their number is retired)'), into: customer.describe('the customer who stays') }).strict();

const retentionArgs = z.object({ days: z.number().int().min(30).max(3650).nullable().describe('keep messages this many days (30 to 3650), or null for the standard period') }).strict();

export function contactTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'contacts_retention_set', capabilityId: 'contacts.retention', policy: 'confirm', undo: 'irreversible', deletes: true,
      description: 'Change how long customer messages are kept. Messages older than the new period are deleted by the daily purge and cannot be recovered, so the merchant confirms with the button.',
      args: retentionArgs,
      read: async (api) => (await api.get('/retention')) as { days: number | null; effectiveDays: number; defaultDays: number },
      plan: (a, s) => {
        const next = a.days ?? s.defaultDays;
        if (next === s.effectiveDays) throw new ToolInputError('no_change');
        return {
          summary: { ar: `تغيير مدة حفظ الرسايل لـ ${next} يوم`, en: `Keep messages for ${next} days` },
          rows: [row('مدة الحفظ (يوم)', 'Keep for (days)', String(s.effectiveDays), String(next)), ...(next < s.effectiveDays ? [row('اللي هيتمسح', 'What is deleted', undefined, `كل رسالة أقدم من ${next} يوم بتتمسح نهائيًا / every message older than ${next} days is deleted for good`)] : [])],
          request: { method: 'PUT', path: '/retention', body: { days: a.days } },
        };
      },
    }, kit),
    writeTool({
      name: 'contact_erase', capabilityId: 'contacts.erase', policy: 'confirm', undo: 'irreversible', deletes: true,
      description: "Erase a customer and everything stored about them (messages, notes, tags, consent). It cannot be undone, so the merchant confirms with the button. Give the customer's name.",
      args: eraseArgs,
      read: async (api, _c, a) => { const c = await findContact(api, a.customer); return { waId: c.waId, name: c.name }; },
      fingerprint: (s) => ({ name: s.name }),
      plan: (a, s) => ({
        summary: { ar: `مسح العميل ${s.name ?? a.customer} نهائيًا`, en: `Erase ${s.name ?? a.customer} for good` },
        rows: [row('اللي هيتمسح', 'What is erased', undefined, 'كل الرسايل والملاحظات والتاجات وإثبات الموافقة / all messages, notes, tags and consent proof')],
        request: { method: 'DELETE', path: `/contacts/${s.waId}` }, hideBody: true,
      }),
    }, kit),
    writeTool({
      name: 'contact_merge', capabilityId: 'contacts.merge', policy: 'confirm', undo: 'irreversible', deletes: true,
      description: 'Fold one customer into another (the same person on a new number). The first one disappears and their history joins the second. It cannot be undone, so the merchant confirms.',
      args: mergeArgs,
      read: async (api, _c, a) => { const f = await findContact(api, a.from); const t = await findContact(api, a.into); if (f.waId === t.waId) throw new ToolInputError('no_change'); return { from: f.waId, into: t.waId, fromName: f.name, intoName: t.name }; },
      fingerprint: (s) => ({ fromName: s.fromName, intoName: s.intoName }),
      plan: (a, s) => ({
        summary: { ar: `دمج ${s.fromName ?? a.from} في ${s.intoName ?? a.into}`, en: `Merge ${s.fromName ?? a.from} into ${s.intoName ?? a.into}` },
        rows: [row('هيتدمج', 'Folded away', undefined, s.fromName ?? a.from), row('هيفضل', 'Stays', undefined, s.intoName ?? a.into)],
        request: { method: 'POST', path: '/contacts/merge', body: { fromWaId: s.from, intoWaId: s.into } }, hideBody: true,
      }),
    }, kit),
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
    }, kit),
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
    }, kit),
  ];
}
