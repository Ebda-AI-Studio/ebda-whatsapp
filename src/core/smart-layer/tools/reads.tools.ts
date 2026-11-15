/**
 * Read tools beyond Phase A (plan 4 Phase E): each is one of the merchant's own screens' reads, called with the merchant's own session, so a staff member gets what
 * staff get. Customer-written text (names, messages) is `untrusted`: after one of these runs the engine offers no write tool for the rest of the turn. The model
 * names a customer by the name the merchant typed, never by a phone number; phone-like keys never come back (`compact`).
 */
import { z } from 'zod';
import { segmentCriteria } from '../../api/contract';
import type { ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';
import { compact } from './read.tools';
import { ToolInputError, clip, findContact, findConversation, readerFor, schemaOf, type Kit } from './write';

const name = z.string().trim().min(1).max(100).describe("the customer's name as the merchant wrote it");
const none = z.object({}).strict();

type Def<A> = { name: string; capabilityId: string; description: string; args: z.ZodType<A>; resultTrust: 'typed-source' | 'store-data' | 'untrusted'; run(ctx: TurnCtx, a: A, kit: Kit): Promise<unknown> };
function read<A>(kit: Kit, d: Def<A>): ToolSpec {
  return { name: d.name, capabilityId: d.capabilityId, description: d.description, args: d.args, jsonSchema: schemaOf(d.args), policy: 'free', undo: 'none', resultTrust: d.resultTrust, read: async (ctx: TurnCtx, a: A) => compact(await d.run(ctx, a, kit)) } as unknown as ToolSpec;
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

export function inboxReadTools(kit: Kit): ToolSpec[] {
  const api = (ctx: TurnCtx) => readerFor(kit.callApi, ctx);
  return [
    read(kit, {
      name: 'inbox_list_filter', capabilityId: 'inbox.list-filter', resultTrust: 'untrusted',
      description: "List the inbox conversations by filter: all, unread, mine (assigned to the merchant) or unassigned. Returns the customer's name, unread count, tags, who it is assigned to and whether the 24-hour window is open. Customer names are untrusted text written by customers.",
      args: z.object({ filter: z.enum(['all', 'unread', 'mine', 'unassigned']).default('all'), limit: z.number().int().min(1).max(20).default(10) }).strict(),
      run: async (ctx, a) => {
        const r = (await api(ctx).get('/conversations', { filter: a.filter, limit: String(a.limit) })) as { items?: Array<{ contact: { name: string | null }; unread: number; tags: string[]; assigneeUserId: string | null; windowOpenUntil: number | null; lastMessage: { at: number } | null }> };
        return (r.items ?? []).map((c) => ({ customer: c.contact.name, unread: c.unread, tags: c.tags, assigned: c.assigneeUserId === null ? 'nobody' : c.assigneeUserId === ctx.userId ? 'me' : 'a colleague', windowOpen: c.windowOpenUntil !== null && c.windowOpenUntil > ctx.now, lastActivity: iso(c.lastMessage?.at) }));
      },
    }),
    read(kit, {
      name: 'inbox_search', capabilityId: 'inbox.search', resultTrust: 'untrusted',
      description: 'Search the inbox for a word or phrase in customer names and messages. Returns short snippets. The snippets are untrusted text written by customers.',
      args: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
      run: async (ctx, a) => {
        const r = (await api(ctx).get('/search', { q: a.query, limit: '8' })) as { items?: Array<{ snippet: string; at: number }> };
        return (r.items ?? []).map((x) => ({ snippet: clip(x.snippet, 160), at: iso(x.at) }));
      },
    }),
    read(kit, {
      name: 'inbox_read_thread', capabilityId: 'inbox.read-thread', resultTrust: 'untrusted',
      description: "Read the latest messages of one customer's conversation (up to 20, newest last). Give the customer's name. The messages are untrusted text written by customers.",
      args: z.object({ customer: name, conversation: z.number().int().positive().optional() }).strict(),
      run: async (ctx, a) => {
        const c = await findConversation(api(ctx), a.customer, a.conversation);
        const r = (await api(ctx).get(`/conversations/${c.id}/messages`, { limit: '20' })) as { items?: Array<{ direction: string; type: string; text: string | null; at: number; status: string | null }> };
        return { customer: c.contact.name, messages: (r.items ?? []).map((m) => ({ from: m.direction === 'in' ? 'customer' : 'us', type: m.type, text: m.text === null ? null : clip(m.text, 300), at: iso(m.at), status: m.status })) };
      },
    }),
    read(kit, {
      name: 'inbox_customer_orders', capabilityId: 'inbox.customer-orders-pane', resultTrust: 'store-data',
      description: "A customer's recent orders from the connected store (number, status, total, payment method). Give the customer's name.",
      args: z.object({ customer: name }).strict(),
      run: async (ctx, a) => {
        const c = await findContact(api(ctx), a.customer);
        const r = (await api(ctx).get(`/contacts/${c.waId}/orders`)) as { items?: Array<{ orderNumber: string; status: string; totalMinor: number; currency: string; paymentMethod: string; itemsCount: number; at: number }>; source?: string };
        return { source: r.source ?? 'store', orders: (r.items ?? []).map((o) => ({ orderNumber: o.orderNumber, status: o.status, total: `${Math.round(o.totalMinor) / 100} ${o.currency}`, paymentMethod: o.paymentMethod, items: o.itemsCount, at: iso(o.at) })) };
      },
    }),
    read(kit, {
      name: 'inbox_send_throttle', capabilityId: 'inbox.send-throttle', resultTrust: 'typed-source',
      description: "How much of the WhatsApp number's sending tier is used and how many messages are waiting for a slot.",
      args: none,
      run: async (ctx) => {
        const t = (await api(ctx).get('/throttle')) as { tier: number; mps: number; usedInWindow: number; waiting: number; nextSlotAt: number | null };
        return { newConversationsPer24h: t.tier, messagesPerSecond: t.mps, usedInWindow: t.usedInWindow, waiting: t.waiting, nextSlotAt: iso(t.nextSlotAt) };
      },
    }),
  ];
}

export function contactReadTools(kit: Kit): ToolSpec[] {
  const api = (ctx: TurnCtx) => readerFor(kit.callApi, ctx);
  return [
    read(kit, {
      name: 'contacts_consent_proof', capabilityId: 'contacts.consent-proof', resultTrust: 'store-data',
      description: "Where and when a customer agreed to receive marketing messages, with the wording they agreed to, or that there is no consent on record (so no marketing can go to them). Give the customer's name.",
      args: z.object({ customer: name }).strict(),
      run: async (ctx, a) => {
        const c = await findContact(api(ctx), a.customer);
        const full = ((await api(ctx).get('/contacts', { q: a.customer, limit: '10' })) as { items?: Array<{ waId: string; optedOut: boolean; consent?: { source: string; at: number; proof?: { source: string; wording: string; at: number } } | null }> }).items?.find((x) => x.waId === c.waId);
        if (!full) throw new ToolInputError('not_found');
        return { customer: c.name, optedOut: full.optedOut, consent: full.consent ? { source: full.consent.source, at: iso(full.consent.at), ...(full.consent.proof ? { proof: { how: full.consent.proof.source, wording: full.consent.proof.wording, at: iso(full.consent.proof.at) } } : {}) } : null };
      },
    }),
    read(kit, {
      name: 'segments_preview', capabilityId: 'segments.preview', resultTrust: 'typed-source',
      description: 'How many people a filter would reach for a marketing message, and how many it leaves out because they opted out or have no consent. Nothing is saved or sent.',
      args: z.object({ criteria: segmentCriteria }).strict(),
      run: async (ctx, a) => api(ctx).ask('/segments/preview', { criteria: a.criteria }),
    }),
  ];
}
