/**
 * Numbers, billing, agent, catalogue, offboarding and shared-template tools (plan 4 Task E7): the rest of the Chat capabilities that have a merchant route. Reads
 * are free and come from the merchant's own screens; every write is confirm class (money, a number, the AI agent speaking to customers, deleting the workspace) and
 * goes through the screen's own route, including the routes' own two-step confirmation (the assistant's confirm button IS that confirmation, sent in the same press).
 * Capabilities that start a card payment (plans, credit packs, InstaPay) are deep links: the payment page link only exists on the screen.
 */
import { z } from 'zod';
import type { ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';
import { ToolApiError } from './read.tools';
import { read } from './reads.tools';
import { ToolInputError, clip, pickByName, readerFor, row, writeTool, type Kit, type Reader } from './write';

const egp = (minor: number) => String(Math.round(minor) / 100);
const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
const none = z.object({}).strict();
const onOff = (b: boolean) => (b ? 'شغّال / on' : 'مقفول / off');
const label = z.string().trim().min(1).max(100).describe('the number\'s verified name, only needed when the merchant has more than one');

type Num = { phoneNumberId: string; verifiedName: string | null; kind: 'own' | 'platform'; status: 'active' | 'disconnected'; registration: string | null; qualityRating: string | null; messagingLimitTier: string | null; throughputLevel: string | null; health?: string; nameStatus: string | null };
type NumbersAnswer = { items: Num[]; notices: Array<{ id: number; kind: string }> };

/** The merchant's own number: the only one, or the one whose verified name they gave. Never taken from the model's words as an id. */
async function ownNumber(api: Reader, name?: string, status: 'active' | 'any' = 'active'): Promise<{ n: Num; all: NumbersAnswer }> {
  const all = (await api.get('/numbers')) as NumbersAnswer;
  const items = all.items.filter((n) => n.kind === 'own' && (status === 'any' || n.status === 'active'));
  if (name) return { n: pickByName(items, (x) => x.verifiedName, name), all };
  if (items.length !== 1) throw new ToolInputError(items.length === 0 ? 'not_found' : 'ambiguous');
  return { n: items[0]!, all };
}

export function accountReadTools(kit: Kit): ToolSpec[] {
  const api = (ctx: TurnCtx) => readerFor(kit.callApi, ctx);
  const nums = async (ctx: TurnCtx) => ((await api(ctx).get('/numbers')) as NumbersAnswer).items;
  return [
    read(kit, { name: 'access_roles', capabilityId: 'access.roles', resultTrust: 'typed-source', description: 'The signed-in person\'s role in this workspace (owner or staff) and what that means for what they can change.', args: none,
      run: async (ctx) => { const me = (await api(ctx).get('/me')) as { role: string }; return { role: me.role, canChangeSettingsAndMoney: me.role === 'owner' || me.role === 'super_admin' }; } }),
    read(kit, { name: 'bot_funnel', capabilityId: 'bot.funnel', resultTrust: 'typed-source', description: 'The ordering bot\'s results for a date range (at most 92 days): how many customers reached each step (conversation, browse, cart, checkout, order, menu, handoff).',
      args: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
      run: async (ctx, a) => { const r = (await api(ctx).get('/bot/funnel', { from: a.from, to: a.to })) as { from: string; to: string; steps: Array<{ step: string; total: number }> }; return { from: r.from, to: r.to, customersPerStep: Object.fromEntries(r.steps.map((s) => [s.step, s.total])) }; } }),
    read(kit, { name: 'catalogue_left_out', capabilityId: 'catalogue.left-out', resultTrust: 'store-data', description: 'Which products are not in the WhatsApp catalogue and why (no image, bad image link, no title, refused by Meta), with the counts.', args: none,
      run: async (ctx) => { const c = (await api(ctx).get('/store-link/catalog')) as { catalogId: string | null; items?: unknown; leftOut?: unknown; error?: string | null; syncing?: boolean; pending?: number }; return { linked: c.catalogId !== null, items: c.items ?? null, leftOut: c.leftOut ?? [], lastSyncError: c.error ?? null, syncing: c.syncing === true, pending: c.pending ?? 0 }; } }),
    read(kit, { name: 'numbers_health', capabilityId: 'numbers.health', resultTrust: 'store-data', description: 'The health of each connected WhatsApp number: green, yellow (flagged, campaigns paused), red or restricted, Meta\'s quality rating and whether registration finished.', args: none,
      run: async (ctx) => (await nums(ctx)).map((n) => ({ name: n.verifiedName, kind: n.kind, status: n.status, health: n.health ?? null, quality: n.qualityRating, registration: n.registration })) }),
    read(kit, { name: 'numbers_tier_limit', capabilityId: 'numbers.tier-limit', resultTrust: 'store-data', description: 'Each connected number\'s Meta messaging limit tier (how many customers it may start a conversation with per day) and throughput.', args: none,
      run: async (ctx) => (await nums(ctx)).map((n) => ({ name: n.verifiedName, tier: n.messagingLimitTier, throughput: n.throughputLevel })) }),
    read(kit, { name: 'numbers_refresh', capabilityId: 'numbers.refresh', resultTrust: 'store-data', description: 'Pull each own number\'s current status from Meta (quality, limit, registration). Sends nothing to customers.', args: none,
      run: async (ctx) => {
        const own = (await nums(ctx)).filter((n) => n.kind === 'own' && n.status === 'active').slice(0, 3);
        const out: unknown[] = [];
        for (const n of own) { const r = (await api(ctx).ask(`/numbers/${n.phoneNumberId}/refresh`, {})) as Partial<Num>; out.push({ name: n.verifiedName, quality: r.qualityRating ?? null, tier: r.messagingLimitTier ?? null, health: r.health ?? null }); }
        return out;
      } }),
    read(kit, { name: 'team_seats_view', capabilityId: 'team.seats-view', resultTrust: 'store-data', description: 'The team: who has a seat, who does not, and how many seats the package allows. Owner only.', args: none,
      run: async (ctx) => { const r = (await api(ctx).get('/members')) as { items?: Array<{ displayName: string; role: string; seat: string }>; seats?: { limit: number; used: number; overLimit: boolean } }; return { seats: r.seats ?? null, people: (r.items ?? []).map((m) => ({ name: m.displayName, role: m.role, seat: m.seat })) }; } }),
    read(kit, { name: 'storelink_bridge_health', capabilityId: 'storelink.bridge-health', resultTrust: 'typed-source', description: 'Whether this workspace is connected to the online store (so orders, COD confirmations and the catalogue work).', args: none,
      run: async (ctx) => { const me = (await api(ctx).get('/me')) as { capabilities?: { codOutcome?: boolean } }; return { storeConnected: me.capabilities?.codOutcome === true }; } }),
    read(kit, { name: 'templates_shared_list', capabilityId: 'templates.shared-list', resultTrust: 'store-data', description: 'For a store on the shared number: the platform\'s ready-made templates it may send, and its own requests for new ones. A store with its own number has none.', args: none,
      run: async (ctx) => {
        try {
          const [t, r] = await Promise.all([api(ctx).get('/templates/shared'), api(ctx).get('/templates/shared-requests')]);
          return { onSharedNumber: true, templates: (t as { items?: unknown[] }).items ?? [], requests: (r as { items?: unknown[] }).items ?? [] };
        } catch (e) { if (e instanceof ToolApiError && e.status === 404) return { onSharedNumber: false }; throw e; }
      } }),
    read(kit, { name: 'wallet_cost_estimate', capabilityId: 'wallet.cost-estimate', resultTrust: 'typed-source', description: 'What sending a number of messages of one category would cost before it is sent: who pays (the wallet or the merchant\'s card), the price per message and the total, in EGP.',
      args: z.object({ category: z.enum(['marketing', 'utility', 'authentication', 'service']), count: z.number().int().min(1).max(1_000_000).default(1) }).strict(),
      run: async (ctx, a) => { const e = (await api(ctx).get('/wallet/estimate', { category: a.category, count: String(a.count) })) as { paidBy: string; perMessageMinor: number; totalMinor: number; priced: boolean }; return { paidBy: e.paidBy, priced: e.priced, perMessage: egp(e.perMessageMinor), total: egp(e.totalMinor), currency: 'EGP' }; } }),
    read(kit, { name: 'wallet_statement', capabilityId: 'wallet.statement', resultTrust: 'typed-source', description: 'The wallet statement for one month (YYYY-MM): what was spent and topped up. Owner only.',
      args: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
      run: async (ctx, a) => api(ctx).get('/wallet/statement', { month: a.month, format: 'json' }) }),
  ];
}

const agentFlags = z.object({ allowRefund: z.boolean().optional(), allowDiscount: z.boolean().optional(), allowFreeDelivery: z.boolean().optional(), allowExchange: z.boolean().optional(), allowGuarantee: z.boolean().optional() }).strict().refine((a) => Object.keys(a).length > 0, 'nothing to change');
const KEYS = ['allowRefund', 'allowDiscount', 'allowFreeDelivery', 'allowExchange', 'allowGuarantee'] as const;
const KEY_AR: Record<(typeof KEYS)[number], string> = { allowRefund: 'يوعد باسترجاع', allowDiscount: 'يوعد بخصم', allowFreeDelivery: 'يوعد بتوصيل مجاني', allowExchange: 'يوعد باستبدال', allowGuarantee: 'يوعد بضمان' };

const TONE_AR = { warm: 'دافية وودودة', professional: 'رسمية ومختصرة', playful: 'مرحة وخفيفة' } as const;

export function accountWriteTools(kit: Kit): ToolSpec[] {
  return [
    writeTool({
      name: 'agent_enable', capabilityId: 'agent.enable', policy: 'confirm', undo: 'reversible', messagesCustomers: true,
      description: 'Turn the AI agent that answers customers on WhatsApp on or off. Turning it on lets it reply to real customers (each reply uses AI credits), so the merchant confirms.',
      args: z.object({ enabled: z.boolean() }).strict(),
      read: async (api) => ({ on: ((await api.get('/agent')) as { enabled: boolean }).enabled }),
      plan: (a, s) => {
        if (s.on === a.enabled) throw new ToolInputError('no_change');
        return { summary: { ar: `${a.enabled ? 'تشغيل' : 'إيقاف'} الموظف الذكي`, en: `${a.enabled ? 'Turn on' : 'Turn off'} the AI agent` }, rows: [row('الموظف الذكي', 'AI agent', onOff(s.on), onOff(a.enabled))], request: { method: 'PUT', path: '/agent', body: { enabled: a.enabled } }, restore: { enabled: s.on } };
      },
    }, kit),
    writeTool({
      name: 'agent_promises', capabilityId: 'agent.promises', policy: 'confirm', undo: 'reversible', money: true, messagesCustomers: true,
      description: 'Choose which promises the AI agent may make to customers: a refund, a discount, free delivery, an exchange, a guarantee. Each is a commitment about money, so the merchant confirms. Send only the ones to change.',
      args: agentFlags,
      read: async (api) => { const g = (await api.get('/agent')) as Record<(typeof KEYS)[number], boolean>; return Object.fromEntries(KEYS.map((k) => [k, g[k] === true])) as Record<(typeof KEYS)[number], boolean>; },
      plan: (a, s) => {
        const changed = KEYS.filter((k) => a[k] !== undefined && a[k] !== s[k]);
        if (!changed.length) throw new ToolInputError('no_change');
        return {
          summary: { ar: 'تعديل اللي الموظف الذكي مسموح يوعد بيه العملاء', en: 'Change what the AI agent may promise customers' },
          rows: changed.map((k) => row(KEY_AR[k], k, onOff(s[k]), onOff(a[k]!))),
          request: { method: 'PUT', path: '/agent', body: Object.fromEntries(changed.map((k) => [k, a[k]])) },
          restore: Object.fromEntries(changed.map((k) => [k, s[k]])),
        };
      },
    }, kit),
    writeTool({
      name: 'agent_tone_set', capabilityId: 'agent.tone', policy: 'preview', undo: 'reversible',
      description: 'Choose how the AI agent sounds to customers: warm, professional or playful. Only the style changes, never what it may promise.',
      args: z.object({ tone: z.enum(['warm', 'professional', 'playful']) }).strict(),
      read: async (api) => ({ tone: ((await api.get('/agent')) as { tone: 'warm' | 'professional' | 'playful' }).tone }),
      plan: (a, s) => {
        if (s.tone === a.tone) throw new ToolInputError('no_change');
        return { summary: { ar: 'تغيير نبرة الموظف الذكي', en: 'Change the AI agent tone' }, rows: [row('النبرة', 'Tone', TONE_AR[s.tone], TONE_AR[a.tone])], request: { method: 'PUT', path: '/agent', body: { tone: a.tone } }, restore: { tone: s.tone } };
      },
    }, kit),
    writeTool({
      name: 'agent_notify_phone_set', capabilityId: 'agent.notify-phone', policy: 'preview', undo: 'reversible',
      description: 'Set (or remove, with null) the WhatsApp number where the owner is told a customer needs a person. International format, for example +201012345678.',
      args: z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/).nullable() }).strict(),
      read: async (api) => ({ phone: ((await api.get('/agent')) as { notifyPhone: string | null }).notifyPhone }),
      // A phone number is personal data: the card shows the last 3 digits only and the stored draft carries no body (apply re-plans from the arguments).
      fingerprint: (s) => ({ set: s.phone !== null, last3: s.phone ? s.phone.slice(-3) : null }),
      plan: (a, s) => {
        if (s.phone === a.phone) throw new ToolInputError('no_change');
        const mask = (p: string | null) => (p ? `…${p.slice(-3)}` : 'مفيش / none');
        return { summary: { ar: a.phone ? 'تحديد رقم تنبيه تحويل العميل لموظف' : 'إلغاء رقم التنبيه', en: a.phone ? 'Set the handoff alert number' : 'Remove the handoff alert number' }, rows: [row('رقم التنبيه', 'Alert number', mask(s.phone), mask(a.phone))], request: { method: 'PUT', path: '/agent', body: { notifyPhone: a.phone } }, hideBody: true, restore: { phone: s.phone } };
      },
    }, kit),
    writeTool({
      name: 'agent_recommendations_toggle', capabilityId: 'agent.recommendations', policy: 'confirm', undo: 'reversible', messagesCustomers: true,
      description: 'Turn on or off the AI agent suggesting products from the catalogue (ideas, alternatives, a gift within a budget, and once after an order). Turning it on can message a customer after an order, so the merchant confirms.',
      args: z.object({ enabled: z.boolean() }).strict(),
      read: async (api) => ({ on: ((await api.get('/agent')) as { recommendProducts: boolean }).recommendProducts === true }),
      plan: (a, s) => {
        if (s.on === a.enabled) throw new ToolInputError('no_change');
        return { summary: { ar: `${a.enabled ? 'تشغيل' : 'إيقاف'} اقتراح المنتجات من الموظف الذكي`, en: `${a.enabled ? 'Turn on' : 'Turn off'} product suggestions by the AI agent` }, rows: [row('اقتراح المنتجات', 'Product suggestions', onOff(s.on), onOff(a.enabled))], request: { method: 'PUT', path: '/agent', body: { recommendProducts: a.enabled } }, restore: { enabled: s.on } };
      },
    }, kit),
    writeTool({
      name: 'catalogue_provision', capabilityId: 'catalogue.provision', policy: 'confirm', undo: 'irreversible',
      description: 'Create a new Meta product catalogue for a merchant who has none and connect it to their WhatsApp Business account. It creates something at Meta that cannot be taken back, so the merchant confirms.',
      args: z.object({ name: z.string().trim().min(1).max(100).optional() }).strict(),
      read: async (api) => ({ catalogId: ((await api.get('/store-link/catalog')) as { catalogId: string | null }).catalogId }),
      plan: (a, s) => {
        if (s.catalogId) throw new ToolInputError('no_change');
        return { summary: { ar: 'إنشاء كتالوج واتساب جديد', en: 'Create a new WhatsApp catalogue' }, rows: [row('الكتالوج', 'Catalogue', 'مفيش / none', a.name ?? 'جديد / new')], request: { method: 'POST', path: '/store-link/catalog/provision', body: a.name ? { name: a.name } : {} } };
      },
    }, kit),
    writeTool({
      name: 'numbers_disconnect', capabilityId: 'numbers.disconnect', policy: 'confirm', undo: 'irreversible',
      description: 'Disconnect one of the merchant\'s own WhatsApp numbers: it stops sending and receiving until it is connected again with the Meta sign-in. Give the number\'s verified name if there is more than one. The merchant confirms.',
      args: z.object({ number: label.optional() }).strict(),
      read: async (api, _c, a) => { const { n } = await ownNumber(api, a.number); return { pn: n.phoneNumberId, name: n.verifiedName }; },
      fingerprint: (s) => ({ name: s.name }),
      plan: (_a, s) => ({ summary: { ar: `فصل رقم واتساب ${s.name ?? ''}`, en: `Disconnect the WhatsApp number ${s.name ?? ''}` }, rows: [row('الرقم', 'Number', s.name ?? '-', 'مفصول / disconnected'), row('اللي هيحصل', 'What happens', undefined, 'مفيش رسايل هتتبعت أو تتستقبل لحد ما توصله تاني / no messages are sent or received until it is connected again')], request: { method: 'POST', path: `/numbers/${s.pn}/disconnect` } }),
    }, kit),
    writeTool({
      name: 'numbers_finish_registration', capabilityId: 'numbers.finish-registration', policy: 'preview', undo: 'reversible',
      description: 'Resume the setup of a number whose registration did not finish (pending, failed or locked).',
      args: z.object({ number: label.optional() }).strict(),
      read: async (api, _c, a) => { const { n } = await ownNumber(api, a.number, 'any'); return { pn: n.phoneNumberId, name: n.verifiedName, registration: n.registration }; },
      plan: (_a, s) => {
        if (s.registration === 'registered' || s.registration === 'not_needed') throw new ToolInputError('no_change');
        return { summary: { ar: `إكمال تسجيل رقم ${s.name ?? ''}`, en: `Finish registering ${s.name ?? 'the number'}` }, rows: [row('التسجيل', 'Registration', s.registration ?? '-', 'بيكمّل / resuming')], request: { method: 'POST', path: `/numbers/${s.pn}/register` } };
      },
    }, kit),
    writeTool({
      name: 'numbers_dismiss_notice', capabilityId: 'numbers.removed-app-notice', policy: 'preview', undo: 'irreversible',
      description: 'Dismiss the notice that says someone removed the app from Meta, keeping the numbers connected. It cannot be brought back, so the merchant confirms.',
      args: z.object({}).strict(),
      read: async (api) => ({ ids: ((await api.get('/numbers')) as NumbersAnswer).notices.map((x) => x.id) }),
      plan: (_a, s) => {
        if (!s.ids.length) throw new ToolInputError('no_change');
        return { summary: { ar: 'إخفاء تنبيه إزالة التطبيق', en: 'Dismiss the removed-app notice' }, rows: [row('التنبيهات', 'Notices', String(s.ids.length), '0')], request: { method: 'POST', path: `/numbers/notices/${s.ids[0]}/dismiss` } };
      },
    }, kit),
    writeTool({
      name: 'numbers_shared_join', capabilityId: 'numbers.shared-join', policy: 'confirm', undo: 'reversible', messagesCustomers: true,
      description: 'Start using the shared platform WhatsApp number (customers will see the display name given). Needs a package that includes it. The merchant confirms.',
      args: z.object({ displayName: z.string().trim().min(2).max(60).optional() }).strict(),
      read: async (api) => (await api.get('/shared-number')) as { available: boolean; member: boolean; displayName: string | null },
      plan: (a, s) => {
        if (!s.available || s.member) throw new ToolInputError(s.member ? 'no_change' : 'unavailable');
        return { summary: { ar: 'الانضمام للرقم المشترك', en: 'Join the shared number' }, rows: [row('الاسم اللي العميل هيشوفه', 'Name customers see', undefined, a.displayName ?? '(تلقائي / automatic)', 'merchant')], request: { method: 'POST', path: '/shared-number/join', body: a.displayName ? { displayName: a.displayName } : {} }, restore: { tool: 'numbers_shared_leave', args: {} } };
      },
    }, kit),
    writeTool({
      name: 'numbers_shared_leave', capabilityId: 'numbers.shared-join', policy: 'confirm', undo: 'reversible', messagesCustomers: true,
      description: 'Stop using the shared platform WhatsApp number. Customers can no longer reach the store through it. The merchant confirms.',
      args: none,
      read: async (api) => (await api.get('/shared-number')) as { available: boolean; member: boolean; displayName: string | null },
      plan: (_a, s) => {
        if (!s.member) throw new ToolInputError('no_change');
        return { summary: { ar: 'ترك الرقم المشترك', en: 'Leave the shared number' }, rows: [row('الرقم المشترك', 'Shared number', 'عضو / member', 'مش عضو / not a member')], request: { method: 'POST', path: '/shared-number/leave' }, ...(s.displayName ? { restore: { tool: 'numbers_shared_join', args: { displayName: s.displayName } } } : {}) };
      },
    }, kit),
    writeTool({
      name: 'offboarding_request', capabilityId: 'offboarding.request', policy: 'confirm', undo: 'reversible', deletes: true, money: true,
      description: 'Ask to delete the whole workspace and its data after a cooling-off period (it can be cancelled until it runs). Any wallet balance is given up. The merchant confirms with the button; ask for a reason.',
      args: z.object({ reason: z.string().trim().min(5).max(300).optional(), acceptWriteOff: z.boolean().optional().describe('true only if the merchant agreed to give up the wallet balance') }).strict(),
      read: async (api) => ({ state: ((await api.get('/offboarding')) as { state: string }).state, balanceMinor: ((await api.get('/wallet')) as { balanceMinor: number }).balanceMinor }),
      plan: (a, s) => {
        if (s.state !== 'none') throw new ToolInputError('no_change');
        if (s.balanceMinor > 0 && a.acceptWriteOff !== true) throw new ToolInputError('unavailable');
        return {
          summary: { ar: 'طلب مسح الحساب بالكامل', en: 'Ask to delete the whole workspace' },
          rows: [row('اللي هيتمسح', 'What is deleted', undefined, 'كل الرسايل والعملاء والقوالب والإعدادات بعد فترة الانتظار / all messages, customers, templates and settings after the cooling-off period'), row('رصيد المحفظة اللي هتتنازل عنه', 'Wallet balance given up (EGP)', undefined, egp(Math.max(0, s.balanceMinor))), ...(a.reason ? [row('السبب', 'Reason', undefined, clip(a.reason, 200), 'merchant')] : [])],
          request: { method: 'POST', path: '/offboarding', body: { confirm: true, ...(a.acceptWriteOff ? { acceptWriteOff: true } : {}), ...(a.reason ? { reason: a.reason } : {}) } },
          restore: { tool: 'offboarding_cancel', args: {} },
        };
      },
    }, kit),
    writeTool({
      name: 'offboarding_cancel', capabilityId: 'offboarding.request', policy: 'confirm', undo: 'reversible',
      description: 'Cancel a pending request to delete the workspace, during its cooling-off period. The merchant confirms.',
      args: none,
      read: async (api) => ({ state: ((await api.get('/offboarding')) as { state: string }).state }),
      plan: (_a, s) => {
        if (s.state !== 'pending') throw new ToolInputError('no_change');
        return { summary: { ar: 'إلغاء طلب مسح الحساب', en: 'Cancel the request to delete the workspace' }, rows: [row('طلب المسح', 'Deletion request', 'مستني / pending', 'اتلغى / cancelled')], request: { method: 'DELETE', path: '/offboarding' } };
      },
    }, kit),
    writeTool({
      name: 'templates_shared_request', capabilityId: 'templates.shared-request', policy: 'confirm', undo: 'irreversible',
      description: 'For a store on the shared number: ask the platform team to add a new ready-made utility or authentication template (marketing is not available on the shared number). The request cannot be withdrawn, so the merchant confirms.',
      args: z.object({ name: z.string().regex(/^[a-z0-9_]{1,512}$/), language: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/), category: z.enum(['UTILITY', 'AUTHENTICATION']), body: z.string().trim().min(1).max(1024) }).strict(),
      read: async (api) => ({ open: (((await api.get('/templates/shared-requests')) as { items?: Array<{ status: string }> }).items ?? []).filter((x) => x.status === 'open').length }),
      plan: (a, s) => ({ summary: { ar: `طلب قالب جديد للرقم المشترك: ${a.name}`, en: `Ask for a new shared-number template: ${a.name}` }, rows: [row('الاسم', 'Name', undefined, `${a.name} (${a.language})`), row('الفئة', 'Category', undefined, a.category), row('النص', 'Text', undefined, a.body, 'merchant'), row('طلبات مفتوحة دلوقتي', 'Open requests now', String(s.open), String(s.open + 1))], request: { method: 'POST', path: '/templates/shared-requests', body: a } }),
    }, kit),
    writeTool({
      name: 'wallet_funding', capabilityId: 'wallet.funding', policy: 'confirm', undo: 'irreversible', money: true,
      description: 'Switch an own WhatsApp number so that Meta bills the merchant\'s own card directly instead of the wallet. Only the merchant can choose it (the platform line is the operator\'s). The merchant confirms.',
      args: z.object({ number: label.optional() }).strict(),
      read: async (api, _c, a) => {
        const { n } = await ownNumber(api, a.number);
        const w = (await api.get('/wallet')) as { funding?: Array<{ phoneNumberId: string; funding: string }> };
        return { pn: n.phoneNumberId, name: n.verifiedName, current: w.funding?.find((f) => f.phoneNumberId === n.phoneNumberId)?.funding ?? 'unknown' };
      },
      fingerprint: (s) => ({ name: s.name, current: s.current }),
      plan: (_a, s) => {
        if (s.current === 'merchant_card' || s.current === 'platform_line') throw new ToolInputError(s.current === 'merchant_card' ? 'no_change' : 'unavailable');
        return { summary: { ar: `ميتا تحاسبك على كارتك مباشرة لرقم ${s.name ?? ''}`, en: `Meta bills your card directly for ${s.name ?? 'the number'}` }, rows: [row('مين بيدفع لميتا', 'Who pays Meta', s.current, 'كارت التاجر / merchant card')], request: { method: 'PUT', path: `/numbers/${s.pn}/funding`, body: { funding: 'merchant_card' } } };
      },
      // The route's own two steps: a preview issues a single-use token bound to the exact change; the confirm presents it. The merchant's press is that confirmation.
      send: async (call, plan) => {
        const pv = (await call({ method: 'POST', path: `${plan.request.path}/preview`, body: plan.request.body })) as { confirm: { confirmId: string; token: string } };
        return call({ ...plan.request, body: { ...(plan.request.body as object), confirmId: pv.confirm.confirmId, token: pv.confirm.token } });
      },
    }, kit),
    writeTool({
      name: 'wallet_refund_request', capabilityId: 'wallet.refund-request', policy: 'confirm', undo: 'irreversible', money: true,
      description: 'Ask for a refund of unused wallet balance (at least 50 EGP). The request goes to the platform team and cannot be withdrawn. The merchant confirms.',
      args: z.object({ amountEgp: z.number().min(50).max(1_000_000).describe('the amount to refund, in EGP'), note: z.string().trim().max(500).optional() }).strict(),
      read: async (api) => { const w = (await api.get('/wallet')) as { availableMinor: number }; const open = (((await api.get('/wallet/refund-requests')) as { items?: Array<{ state: string }> }).items ?? []).filter((x) => x.state === 'pending' || x.state === 'processing').length; return { availableMinor: w.availableMinor, open }; },
      plan: (a, s) => {
        const minor = Math.round(a.amountEgp * 100);
        if (minor > s.availableMinor) throw new ToolInputError('unavailable');
        return { summary: { ar: `طلب استرجاع ${egp(minor)} جنيه من المحفظة`, en: `Ask for a refund of ${egp(minor)} EGP from the wallet` }, rows: [row('المبلغ (جنيه)', 'Amount (EGP)', undefined, egp(minor)), row('المتاح في المحفظة (جنيه)', 'Available in the wallet (EGP)', egp(s.availableMinor), egp(s.availableMinor)), ...(a.note ? [row('ملاحظة', 'Note', undefined, clip(a.note, 200), 'merchant')] : [])], request: { method: 'POST', path: '/wallet/refund-requests', body: { amountMinor: minor, ...(a.note ? { note: a.note } : {}) } } };
      },
    }, kit),
    writeTool({
      name: 'wallet_yearly_refund_request', capabilityId: 'wallet.yearly-refund-request', policy: 'confirm', undo: 'irreversible', money: true,
      description: 'Ask to cancel the yearly package and refund the unused months. The card shows the platform\'s own quote; filing it moves no money by itself (a person executes it) and cannot be withdrawn. The merchant confirms.',
      args: none,
      read: async (api) => (await api.get('/wallet/yearly-refund')) as { quote: { unusedMonths: number; grossMinor: number; debtSettledMinor: number; refundMinor: number; periodMonths: number } | null; reason: string | null; request: { state: string } | null },
      plan: (_a, s) => {
        if (!s.quote || s.request) throw new ToolInputError('unavailable');
        return { summary: { ar: 'طلب إلغاء الباقة السنوية واسترجاع الشهور اللي ما اتستخدمتش', en: 'Ask to cancel the yearly package and refund the unused months' }, rows: [row('شهور ما اتستخدمتش', 'Unused months', undefined, `${s.quote.unusedMonths} / ${s.quote.periodMonths}`), row('المبلغ قبل الخصم (جنيه)', 'Gross (EGP)', undefined, egp(s.quote.grossMinor)), row('مديونية هتتسوّى (جنيه)', 'Debt settled (EGP)', undefined, egp(s.quote.debtSettledMinor)), row('اللي هيتسترجع (جنيه)', 'Refund (EGP)', undefined, egp(s.quote.refundMinor))], request: { method: 'POST', path: '/wallet/yearly-refund/requests' } };
      },
      send: async (call) => {
        const pv = (await call({ method: 'POST', path: '/wallet/yearly-refund/preview', body: {} })) as { confirm: { confirmId: string; token: string } };
        return call({ method: 'POST', path: '/wallet/yearly-refund/requests', body: { confirmId: pv.confirm.confirmId, token: pv.confirm.token } });
      },
    }, kit),
  ];
}
