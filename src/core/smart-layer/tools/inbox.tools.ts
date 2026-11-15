/** Inbox write tools (wave 1): tag, note and assign a conversation. The conversation is found from the customer's name in the merchant's own inbox. */
import { z } from 'zod';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import type { CallApi } from './read.tools';
import { clip, findConversation, row, writeTool } from './write';

const tag = z.string().trim().min(1).max(32);
const who = { customer: z.string().trim().min(1).max(100).describe("the customer's name as the merchant wrote it"), conversation: z.number().int().positive().optional() };
const uid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const tagsArgs = z.object({ ...who, tags: z.array(tag).max(10).describe('the full list of tags the conversation should have afterwards') }).strict();
const noteArgs = z.object({ ...who, text: z.string().trim().min(1).max(2000) }).strict();
const assignArgs = z.object({ ...who, to: z.union([z.literal('me'), z.literal('nobody'), uid]).describe("'me', 'nobody', or a team member's user id") }).strict();

export function inboxTools(callApi: CallApi): ToolSpec[] {
  return [
    writeTool({
      name: 'conversation_tag_set', capabilityId: 'inbox.conversation-tags', policy: 'preview', undo: 'reversible',
      description: "Set the tags on a customer's conversation (replaces the list). Give the customer's name. Shows a preview first; nothing changes until the merchant applies it.",
      args: tagsArgs,
      read: async (api, _c, a) => { const c = await findConversation(api, a.customer, a.conversation); return { id: c.id, tags: [...c.tags].sort() }; },
      plan: (a, s) => ({
        summary: { ar: `تعديل تاجات المحادثة (${a.customer})`, en: `Change the tags on the conversation (${a.customer})` },
        rows: [row('التاجات', 'Tags', s.tags.join('، ') || '-', a.tags.join('، ') || '-')],
        request: { method: 'PUT', path: `/conversations/${s.id}/tags`, body: { tags: a.tags } },
        restore: { customer: a.customer, conversation: s.id, tags: s.tags },
      }),
    }, callApi),
    writeTool({
      name: 'conversation_note_add', capabilityId: 'inbox.notes', policy: 'preview', undo: 'irreversible',
      description: 'Add an internal note (never sent to the customer) to a customer conversation. A note cannot be deleted afterwards, so the merchant confirms it.',
      args: noteArgs,
      read: async (api, _c, a) => {
        const c = await findConversation(api, a.customer, a.conversation);
        const notes = (await api.get(`/conversations/${c.id}/notes`)) as { items?: unknown[] };
        return { id: c.id, notes: notes.items?.length ?? 0 };
      },
      plan: (a, s) => ({
        summary: { ar: `إضافة ملاحظة داخلية على محادثة ${a.customer}`, en: `Add an internal note to ${a.customer}'s conversation` },
        rows: [row('الملاحظة (للفريق فقط، العميل مش هيشوفها)', 'Note (team only, the customer never sees it)', undefined, clip(a.text), 'merchant')],
        request: { method: 'POST', path: `/conversations/${s.id}/notes`, body: { text: a.text } },
      }),
    }, callApi),
    writeTool({
      name: 'conversation_assign', capabilityId: 'inbox.assign-takeover', policy: 'preview', undo: 'reversible',
      description: "Assign a customer's conversation to a team member, to the merchant ('me'), or to nobody. Give the customer's name.",
      args: assignArgs,
      read: async (api, _c, a) => { const c = await findConversation(api, a.customer, a.conversation); return { id: c.id, assignee: c.assigneeUserId }; },
      plan: (a, s, ctx) => {
        const target = a.to === 'me' ? ctx.userId : a.to === 'nobody' ? null : a.to;
        const label = (u: string | null) => (u === null ? '-' : u === ctx.userId ? 'أنا / me' : 'عضو في الفريق / team member');
        return {
          summary: { ar: `تحويل محادثة ${a.customer}`, en: `Assign ${a.customer}'s conversation` },
          rows: [row('مسؤول المحادثة', 'Assigned to', label(s.assignee), label(target))],
          request: { method: 'POST', path: `/conversations/${s.id}/assign`, body: { userId: target } },
          restore: { customer: a.customer, conversation: s.id, to: s.assignee === null ? 'nobody' : s.assignee === ctx.userId ? 'me' : s.assignee },
        };
      },
    }, callApi),
  ];
}
