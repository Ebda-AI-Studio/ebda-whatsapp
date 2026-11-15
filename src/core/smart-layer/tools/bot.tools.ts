/** Bot, catalogue, agent, digest and team write tools (wave 1). Each reads the screen's own route and sends the screen's own request. */
import { z } from 'zod';
import { hoursSchema, locationSchema, menuSchema, type HoursSettings, type LocationSettings, type MenuSettings } from '../../store-link/bot-settings';
import type { ToolSpec } from '../../../../foundation/smart-layer/types';
import type { CallApi } from './read.tools';
import { ToolInputError, clip, pickByName, row, writeTool, type Reader } from './write';

type Settings = { orderConfirmations: boolean; orderingBot: boolean; otpViaWhatsApp: boolean; catalogId: string | null; menu: MenuSettings; hours: HoursSettings; location: LocationSettings };
const settings = async (api: Reader) => (await api.get('/store-link/settings')) as Settings;
const onOff = (b: boolean) => (b ? 'شغّال / on' : 'مقفول / off');
const j = (v: unknown) => clip(JSON.stringify(v), 500);

const menuArgs = z.object({ menu: menuSchema.describe('the whole service menu (replaces the current one): up to 8 items, each with an id slug, a title (24 chars) and an answer in Arabic and English') }).strict();
const hoursArgs = z.object({ hours: hoursSchema.describe('the whole business-hours setting (Cairo time, weekdays 0=Sunday..6=Saturday, HH:MM) with the away message') }).strict();
const locationArgs = z.object({ location: locationSchema.describe('the shop location, or null to remove it') }).strict();
const toggleArgs = z.object({ enabled: z.boolean() }).strict();
const catalogArgs = z.object({ catalog: z.string().regex(/^\d{5,25}$/).describe("the Meta catalogue number to connect") }).strict();
const commerceArgs = z.object({ catalogVisible: z.boolean().describe('show the shop button on the number'), cartEnabled: z.boolean().describe('allow the cart') }).strict();
const personaArgs = z.object({ persona: z.string().max(1000).optional(), language: z.enum(['ar', 'en', 'auto']).optional() }).strict().refine((a) => a.persona !== undefined || a.language !== undefined, 'nothing to change');
const faqArgs = z.object({ text: z.string().trim().min(1).max(20_000), mode: z.enum(['append', 'replace']).default('append').describe("'append' adds to the end (the usual case), 'replace' swaps the whole text") }).strict();
const digestArgs = toggleArgs;
const seatArgs = z.object({ member: z.string().trim().min(1).max(100).describe("the team member's display name") }).strict();

function switchTool(name: string, capabilityId: string, key: 'orderingBot' | 'orderConfirmations', labels: { ar: string; en: string }, description: string, o: { policy: 'preview' | 'confirm'; messagesCustomers?: boolean }, callApi: CallApi): ToolSpec {
  return writeTool({
    name, capabilityId, description, args: toggleArgs, policy: o.policy, undo: 'reversible', ...(o.messagesCustomers ? { messagesCustomers: true } : {}),
    read: async (api) => ({ on: (await settings(api))[key] }),
    plan: (a, s) => {
      if (s.on === a.enabled) throw new ToolInputError('no_change');
      return {
        summary: { ar: `${a.enabled ? 'تشغيل' : 'إيقاف'} ${labels.ar}`, en: `${a.enabled ? 'Turn on' : 'Turn off'} ${labels.en}` },
        rows: [row(labels.ar, labels.en, onOff(s.on), onOff(a.enabled))],
        request: { method: 'PATCH', path: '/store-link/settings', body: { [key]: a.enabled } },
        restore: { enabled: s.on },
      };
    },
    // Turning ON a switch that messages customers takes the route's own two steps (SETTINGS-CONFIRM-1): the merchant's press in the assistant IS that confirmation.
    send: async (call, plan, a) => {
      if (key === 'orderConfirmations' && a.enabled) {
        const t = (await call({ method: 'POST', path: '/store-link/settings/preview', body: plan.request.body })) as { confirmToken: string };
        return call({ ...plan.request, body: { ...(plan.request.body as object), confirmToken: t.confirmToken } });
      }
      return call(plan.request);
    },
  }, callApi);
}

export function botTools(callApi: CallApi): ToolSpec[] {
  const setting = <K extends 'menu' | 'hours' | 'location', A extends z.ZodType>(name: string, capabilityId: string, key: K, args: A, titleAr: string, titleEn: string, description: string): ToolSpec =>
    writeTool<Record<K, unknown>, Settings[K]>({
      name, capabilityId, description, args: args as never, policy: 'preview', undo: 'reversible',
      read: async (api) => (await settings(api))[key],
      plan: (a, s) => {
        const next = a[key];
        if (JSON.stringify(next) === JSON.stringify(s)) throw new ToolInputError('no_change');
        return { summary: { ar: `تعديل ${titleAr}`, en: `Change ${titleEn}` }, rows: [row(titleAr, titleEn, j(s), j(next), 'merchant')], request: { method: 'PATCH', path: '/store-link/settings', body: { [key]: next } }, restore: { [key]: s } };
      },
    }, callApi);
  return [
    setting('bot_menu_set', 'bot.service-menu', 'menu', menuArgs, 'قائمة الخدمات', 'the service menu', 'Replace the bot\'s service menu (the list a customer sees). Send the whole new menu.'),
    setting('bot_hours_set', 'bot.hours-away', 'hours', hoursArgs, 'مواعيد العمل ورسالة الغياب', 'business hours and the away message', 'Replace the business hours and the away message. Send the whole new setting.'),
    setting('bot_location_set', 'bot.location', 'location', locationArgs, 'موقع المحل', 'the shop location', 'Set (or remove, with null) the shop location the bot sends.'),
    switchTool('bot_ordering_toggle', 'bot.ordering-toggle', 'orderingBot', { ar: 'بوت الطلبات', en: 'the ordering bot' }, 'Turn the ordering bot on or off.', { policy: 'preview' }, callApi),
    switchTool('bot_order_confirmations_toggle', 'bot.order-confirmations-toggle', 'orderConfirmations', { ar: 'رسائل تأكيد الطلبات للعملاء', en: 'order confirmation messages to customers' }, 'Turn the order confirmation messages (sent to customers) on or off. Turning them on messages customers, so the merchant confirms it.', { policy: 'confirm', messagesCustomers: true }, callApi),

    writeTool({
      name: 'catalogue_resync', capabilityId: 'catalogue.resync', policy: 'preview', undo: 'irreversible',
      description: 'Start a fresh full pass of the WhatsApp catalogue sync. It re-sends every product to Meta and cannot be taken back, so the merchant confirms it.',
      args: z.object({}).strict(),
      read: async (api) => { const c = (await api.get('/store-link/catalog')) as { catalogId: string | null; syncing?: boolean; pending?: number }; return { catalogId: c.catalogId, syncing: c.syncing === true, pending: c.pending ?? 0 }; },
      plan: (_a, s) => {
        if (!s.catalogId) throw new ToolInputError('unavailable');
        return { summary: { ar: 'إعادة مزامنة كتالوج واتساب كله', en: 'Re-sync the whole WhatsApp catalogue' }, rows: [row('حالة المزامنة', 'Sync', s.syncing ? 'شغالة / running' : 'واقفة / idle', 'بداية مزامنة كاملة / full pass')], request: { method: 'POST', path: '/store-link/catalog/resync' } };
      },
    }, callApi),
    writeTool({
      name: 'catalogue_toggles_set', capabilityId: 'catalogue.commerce-toggles', policy: 'preview', undo: 'reversible',
      description: 'Show or hide the shop button and the cart on the WhatsApp number.',
      args: commerceArgs,
      read: async (api) => { const c = (await api.get('/store-link/catalog')) as { catalogId: string | null; commerce?: { catalogVisible: boolean; cartEnabled: boolean } | null }; if (!c.catalogId) throw new ToolInputError('unavailable'); return { commerce: c.commerce ?? null }; },
      plan: (a, s) => {
        if (s.commerce && s.commerce.catalogVisible === a.catalogVisible && s.commerce.cartEnabled === a.cartEnabled) throw new ToolInputError('no_change');
        return {
          summary: { ar: 'تعديل زر المتجر والسلة على الرقم', en: 'Change the shop button and cart on the number' },
          rows: [row('زر المتجر', 'Shop button', s.commerce ? onOff(s.commerce.catalogVisible) : '?', onOff(a.catalogVisible)), row('السلة', 'Cart', s.commerce ? onOff(s.commerce.cartEnabled) : '?', onOff(a.cartEnabled))],
          request: { method: 'PUT', path: '/store-link/catalog/commerce', body: { catalogVisible: a.catalogVisible, cartEnabled: a.cartEnabled } },
          ...(s.commerce ? { restore: { catalogVisible: s.commerce.catalogVisible, cartEnabled: s.commerce.cartEnabled } } : {}),
        };
      },
    }, callApi),
    writeTool({
      name: 'catalogue_link_existing', capabilityId: 'catalogue.link-existing', policy: 'preview', undo: 'reversible',
      description: 'Connect an existing Meta catalogue (by its number) to the store link. Only a catalogue connected to this workspace\'s WhatsApp account is accepted by the route.',
      args: catalogArgs,
      read: async (api) => ({ catalog: (await settings(api)).catalogId }),
      plan: (a, s) => {
        if (s.catalog === a.catalog) throw new ToolInputError('no_change');
        return { summary: { ar: 'ربط كتالوج موجود', en: 'Connect an existing catalogue' }, rows: [row('رقم الكتالوج', 'Catalogue number', s.catalog ?? '-', a.catalog)], request: { method: 'PATCH', path: '/store-link/settings', body: { catalogId: a.catalog } }, ...(s.catalog ? { restore: { catalog: s.catalog } } : {}) };
      },
    }, callApi),

    writeTool({
      name: 'agent_persona_set', capabilityId: 'agent.persona-language', policy: 'preview', undo: 'reversible',
      description: 'Change how the AI agent introduces itself (persona text) and/or the language it answers in.',
      args: personaArgs,
      read: async (api) => { const g = (await api.get('/agent')) as { persona: string; language: 'ar' | 'en' | 'auto' }; return { persona: g.persona, language: g.language }; },
      plan: (a, s) => {
        const next = { persona: a.persona ?? s.persona, language: a.language ?? s.language };
        if (next.persona === s.persona && next.language === s.language) throw new ToolInputError('no_change');
        return {
          summary: { ar: 'تعديل شخصية الموظف الذكي ولغته', en: 'Change the AI agent persona and language' },
          rows: [...(next.persona !== s.persona ? [row('الشخصية', 'Persona', clip(s.persona || '-'), clip(next.persona), 'merchant')] : []), ...(next.language !== s.language ? [row('اللغة', 'Language', s.language, next.language)] : [])],
          request: { method: 'PUT', path: '/agent', body: next },
          restore: { persona: s.persona, language: s.language },
        };
      },
    }, callApi),
    writeTool({
      name: 'agent_faq_update', capabilityId: 'agent.faq', policy: 'preview', undo: 'reversible',
      description: 'Add to (default) or replace the AI agent\'s FAQ / knowledge text. Only because the merchant asked. The preview shows the end result.',
      args: faqArgs,
      read: async (api) => ({ faq: ((await api.get('/agent')) as { faqText: string }).faqText }),
      plan: (a, s) => {
        const next = a.mode === 'replace' ? a.text : s.faq ? `${s.faq}\n\n${a.text}` : a.text;
        if (next.length > 20_000) throw new ToolInputError('unavailable');
        if (next === s.faq) throw new ToolInputError('no_change');
        return {
          summary: a.mode === 'replace' ? { ar: 'استبدال نص الأسئلة الشائعة بالكامل', en: 'Replace the whole FAQ text' } : { ar: 'إضافة للأسئلة الشائعة', en: 'Add to the FAQ' },
          rows: [row('الأسئلة الشائعة', 'FAQ', a.mode === 'replace' ? clip(s.faq || '-', 300) : `${s.faq.length} حرف / chars`, clip(a.mode === 'replace' ? next : a.text, 500), 'merchant')],
          request: { method: 'PUT', path: '/agent', body: { faqText: next } },
          ...(s.faq.trim() ? { restore: { text: s.faq, mode: 'replace' } } : {}),
        };
      },
    }, callApi),

    writeTool({
      name: 'digest_settings_set', capabilityId: 'digest.weekly', policy: 'preview', undo: 'reversible',
      description: 'Turn the weekly summary on or off.',
      args: digestArgs,
      read: async (api) => ({ on: ((await api.get('/digest')) as { enabled: boolean }).enabled }),
      plan: (a, s) => {
        if (s.on === a.enabled) throw new ToolInputError('no_change');
        return { summary: { ar: `${a.enabled ? 'تشغيل' : 'إيقاف'} الملخص الأسبوعي`, en: `${a.enabled ? 'Turn on' : 'Turn off'} the weekly summary` }, rows: [row('الملخص الأسبوعي', 'Weekly summary', onOff(s.on), onOff(a.enabled))], request: { method: 'PUT', path: '/digest', body: { enabled: a.enabled } }, restore: { enabled: s.on } };
      },
    }, callApi),
    writeTool({
      name: 'seat_assign', capabilityId: 'team.seat-assign', policy: 'preview', undo: 'reversible',
      description: 'Give a staff member a seat (so they can use the inbox). Give their display name. Seats are limited by the package.',
      args: seatArgs,
      read: async (api, _c, a) => {
        const r = (await api.get('/members')) as { items?: Array<{ userId: string; displayName: string; role: string; seat: string }>; seats?: { limit: number; used: number } };
        const m = pickByName((r.items ?? []).filter((x) => x.role === 'staff'), (x) => x.displayName, a.member);
        return { userId: m.userId, name: m.displayName, seat: m.seat, seats: r.seats ?? null };
      },
      fingerprint: (s) => ({ seat: s.seat, seats: s.seats }),
      plan: (_a, s) => {
        if (s.seat === 'seated') throw new ToolInputError('no_change');
        return { summary: { ar: `إعطاء مقعد لـ ${s.name}`, en: `Give ${s.name} a seat` }, rows: [row('المقعد', 'Seat', 'بدون / none', 'مقعد / seat'), ...(s.seats ? [row('المقاعد المستخدمة', 'Seats used', `${s.seats.used}/${s.seats.limit}`, `${s.seats.used + 1}/${s.seats.limit}`)] : [])], request: { method: 'PUT', path: `/members/${s.userId}/seat` } };
      },
    }, callApi),
  ];
}
