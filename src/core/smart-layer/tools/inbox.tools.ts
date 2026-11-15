/** Inbox write tools (wave 1): tag, note and assign a conversation. The conversation is found from the customer's name in the merchant's own inbox. */
import { z } from 'zod';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import { ToolInputError, clip, findContact, findConversation, row, writeTool, type Kit } from './write';

const tag = z.string().trim().min(1).max(32);
const who = { customer: z.string().trim().min(1).max(100).describe("the customer's name as the merchant wrote it"), conversation: z.number().int().positive().optional() };
const uid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

const tagsArgs = z.object({ ...who, tags: z.array(tag).max(10).describe('the full list of tags the conversation should have afterwards') }).strict();
const noteArgs = z.object({ ...who, text: z.string().trim().min(1).max(2000) }).strict();
const assignArgs = z.object({ ...who, to: z.union([z.literal('me'), z.literal('nobody'), uid]).describe("'me', 'nobody', or a team member's user id") }).strict();

const sendTextArgs = z.object({ ...who, text: z.string().trim().min(1).max(4096).describe('the exact message to send to the customer') }).strict();
const sendTemplateArgs = z.object({ ...who, template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(10) }), params: z.array(z.string().max(1000)).max(20).default([]) }).strict();
type Win = { id: number; open: boolean; windowOpenUntil: number | null };
/** A send goes out once: the idempotency key is made at press time, not at preview time, so the previewed payload stays comparable. */
const withClientId = (call: (r: { method: 'POST'; path: string; body: unknown }) => Promise<unknown>, plan: { request: { path: string; body?: unknown } }) =>
  call({ method: 'POST', path: plan.request.path, body: { ...(plan.request.body as object), clientId: crypto.randomUUID() } });

const codArgs = z.object({ customer: who.customer, orderNumber: z.string().regex(/^[\w-]{1,40}$/).describe('the order number'), outcome: z.enum(['confirmed', 'refused']).describe('did the customer confirm the cash-on-delivery order, or refuse it') }).strict();
const markArgs = z.object({ ...who }).strict();

export function inboxTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'inbox_cod_outcome', capabilityId: 'inbox.cod-outcome', policy: 'confirm', undo: 'irreversible',
      description: "Record that a customer confirmed or refused a cash-on-delivery order, and tell the store. Once recorded it cannot be changed, so the merchant confirms with the button. Give the customer's name and the order number.",
      args: codArgs,
      read: async (api, _c, a) => {
        const c = await findContact(api, a.customer);
        const orders = ((await api.get(`/contacts/${c.waId}/orders`)) as { items?: Array<{ orderNumber: string; paymentMethod: string; status: string; totalMinor: number; currency: string }> }).items ?? [];
        const o = orders.find((x) => x.orderNumber === a.orderNumber);
        if (!o || o.paymentMethod !== 'cod' || o.status !== 'pending_confirmation') throw new ToolInputError('unavailable');
        return { waId: c.waId, name: c.name, order: o.orderNumber, total: `${Math.round(o.totalMinor) / 100} ${o.currency}` };
      },
      fingerprint: (s) => ({ order: s.order, total: s.total }),
      plan: (a, s) => ({
        summary: { ar: `تسجيل إن ${s.name ?? a.customer} ${a.outcome === 'confirmed' ? 'أكّد' : 'رفض'} الأوردر ${s.order}`, en: `Record that ${s.name ?? a.customer} ${a.outcome} order ${s.order}` },
        rows: [row('الأوردر', 'Order', undefined, `${s.order} (${s.total})`), row('النتيجة', 'Outcome', 'مستني التأكيد / awaiting confirmation', a.outcome === 'confirmed' ? 'اتأكد / confirmed' : 'اترفض / refused')],
        request: { method: 'POST', path: `/contacts/${s.waId}/orders/${s.order}/cod-outcome`, body: { outcome: a.outcome } }, hideBody: false,
      }),
      send: async (call, plan) => call({ method: 'POST', path: plan.request.path, body: { ...(plan.request.body as object), idempotencyKey: crypto.randomUUID() } }),
    }, kit),
    writeTool({
      name: 'inbox_mark_read', capabilityId: 'inbox.mark-read', policy: 'preview', undo: 'irreversible',
      description: "Mark a customer's conversation as read (clears its unread count). It cannot be marked unread again, so the merchant confirms. Give the customer's name.",
      args: markArgs,
      read: async (api, _c, a) => { const c = await findConversation(api, a.customer, a.conversation) as { id: number; unread?: number }; return { id: c.id, unread: c.unread ?? 0 }; },
      plan: (a, s) => {
        if (s.unread === 0) throw new ToolInputError('no_change');
        return { summary: { ar: `تعليم محادثة ${a.customer} كمقروءة`, en: `Mark ${a.customer}'s conversation as read` }, rows: [row('الرسايل الجديدة', 'Unread messages', String(s.unread), '0')], request: { method: 'POST', path: `/conversations/${s.id}/read` } };
      },
    }, kit),
    writeTool({
      name: 'send_text', capabilityId: 'inbox.send-text', policy: 'confirm', undo: 'irreversible', messagesCustomers: true,
      description: "Send a text message to a customer in their conversation. It goes to a real person and cannot be taken back, so the merchant confirms with the button; the card shows the exact text. Only works while the 24-hour reply window is open (otherwise use send_template).",
      args: sendTextArgs,
      read: async (api, ctx, a): Promise<Win> => { const c = await findConversation(api, a.customer, a.conversation); const until = (c as { windowOpenUntil?: number | null }).windowOpenUntil ?? null; return { id: c.id, open: until !== null && until > ctx.now, windowOpenUntil: until }; },
      // The window closing by a minute is not a reason to re-preview; open/closed is.
      fingerprint: (s) => ({ id: s.id, open: s.open }),
      plan: (a, s) => {
        if (!s.open) throw new ToolInputError('unavailable');
        return {
          summary: { ar: `إرسال رسالة لـ ${a.customer}`, en: `Send a message to ${a.customer}` },
          rows: [row('الرسالة (هتتبعت زي ما هي)', 'Message (sent exactly as written)', undefined, a.text, 'merchant')],
          request: { method: 'POST', path: `/conversations/${s.id}/messages`, body: { type: 'text', text: a.text } },
        };
      },
      send: async (call, plan) => withClientId(call as never, plan),
    }, kit),
    writeTool({
      name: 'send_template', capabilityId: 'inbox.send-template', policy: 'confirm', undo: 'irreversible', messagesCustomers: true,
      description: "Send an approved WhatsApp template to a customer (works when the 24-hour window is closed too). It goes to a real person and cannot be taken back, so the merchant confirms; the card shows the template text.",
      args: sendTemplateArgs,
      read: async (api, _c, a) => {
        const c = await findConversation(api, a.customer, a.conversation);
        const t = ((await api.get('/templates')) as { items?: Array<{ name: string; language: string; status: string; bodyText: string; paramCount: number }> }).items?.find((x) => x.name === a.template.name && x.language === a.template.language);
        if (!t || t.status !== 'APPROVED') throw new ToolInputError('unavailable');
        return { id: c.id, body: t.bodyText, paramCount: t.paramCount };
      },
      plan: (a, s) => {
        if (a.params.length !== s.paramCount) throw new ToolInputError('unavailable');
        const text = s.body.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => a.params[Number(n) - 1] ?? '');
        return {
          summary: { ar: `إرسال قالب لـ ${a.customer}`, en: `Send a template to ${a.customer}` },
          rows: [row('القالب', 'Template', undefined, `${a.template.name} (${a.template.language})`), row('النص اللي هيوصل', 'The text that will arrive', undefined, text, 'merchant')],
          request: { method: 'POST', path: `/conversations/${s.id}/messages`, body: { type: 'template', name: a.template.name, language: a.template.language, params: a.params } },
        };
      },
      send: async (call, plan) => withClientId(call as never, plan),
    }, kit),
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
    }, kit),
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
    }, kit),
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
    }, kit),
  ];
}
