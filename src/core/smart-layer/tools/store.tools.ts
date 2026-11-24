/**
 * Store-wide tools for the owner assistant (Store ruling CHAT-ASSIST-1), both over the Store bridge through Chat's own routes (`routes/store-assist.ts`):
 *  - `store_top_products` (read, free): best sellers of today / 7 days / 30 days, name + units + revenue, at most 10. Every number comes from the Store's analytics; the model quotes
 *    the strings below as given (the invented-figure guard in `routes/assistant-observe.ts` compares what it says with what this returned).
 *  - `store_create_coupon` (write, confirm class, owner only): a percentage or fixed coupon with a window and an optional usage limit. NOTHING is written until the merchant presses
 *    confirm on the card (the engine issues the approval token; `apply` runs only from that press). The Store's own coupon service does the write; the limits here are the same ones the Store applies,
 *    checked early so a card never promises what the Store will refuse. Undo: none (the Store has no delete RPC; the owner switches a coupon off in the Store admin).
 * A standalone workspace has no Store: both names are in `NEEDS_STORE`.
 */
import { z } from 'zod';
import { sha256Hex } from '../../../../foundation/smart-layer/release';
import type { ToolSpec, TurnCtx } from '../../../../foundation/smart-layer/types';
import { COUPON_LIMITS, ORDER_PERIODS } from '../../store-bridge';
import { read } from './reads.tools';
import { ToolInputError, readerFor, row, stableUuid, writeTool, type Kit, type Reader } from './write';

type TopItem = { name: string; nameAr: string | null; units: number; revenueMinor: number };
type TopAnswer = { currency: string; period: 'today' | '7d' | '30d'; items: TopItem[] };
const PERIOD_DAYS = { today: 1, '7d': 7, '30d': 30 } as const;
/** Money as the tool prints it: always two decimals, so "5,400" or "5400.00" typed by the model both match what was returned. */
const money = (minor: number, currency: string): string => `${(Math.round(minor) / 100).toFixed(2)} ${currency}`;

const topArgs = z.object({
  period: z.enum(['today', '7d', '30d']).default('30d').describe("'today', '7d' (last 7 days) or '30d' (last 30 days, the default)"),
  limit: z.number().int().min(1).max(10).default(5).describe('how many products, 1 to 10 (default 5)'),
}).strict();

/** "13,000.00 EGP" / "13,000.00 جنيه": Latin digits and a comma grouping in both languages (the house style of the Arabic copy and what the invented-figure guard compares), the currency word per language. */
const fmtMoney = (minor: number, currency: string, locale: 'ar' | 'en'): string => `${(Math.round(minor) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${locale === 'ar' && currency === 'EGP' ? 'جنيه' : currency}`;
const fmtCount = (n: number): string => n.toLocaleString('en-US');
export type OrdersFigures = { period: 'today' | 'yesterday' | 'this_week' | 'last_7_days' | 'this_month'; currency: string; orderCount: number; collectedOrders: number; salesMinor: number; refundsMinor: number; avgOrderMinor: number };
const PERIOD_LABEL: Record<OrdersFigures['period'], { ar: string; en: string }> = {
  today: { ar: 'النهارده', en: 'Today' }, yesterday: { ar: 'امبارح', en: 'Yesterday' }, this_week: { ar: 'الأسبوع ده', en: 'This week' },
  last_7_days: { ar: 'آخر 7 أيام', en: 'The last 7 days' }, this_month: { ar: 'الشهر ده', en: 'This month' },
};
/**
 * The orders answer, written from the Store's figures and nothing else, in the language the merchant ASKED in. The binding-claims rail (vendored) treats a refund word as a billing / legal term that only a typed source
 * may back, so a model sentence about refunds with a store-data figure was replaced by "see the Terms page", and the model answered in the UI language, not the question's. This text never goes through the model: every
 * figure is the tool's, refunds are always stated (0.00 when none), and nothing can be invented. `routes/assistant-observe.ts` swaps it in when this tool was the turn's only tool.
 */
export function renderOrdersSummary(f: OrdersFigures, lang: 'ar' | 'en'): string {
  const m = (minor: number) => fmtMoney(minor, f.currency, lang);
  const label = PERIOD_LABEL[f.period][lang];
  if (lang === 'ar') {
    if (f.orderCount === 0) return `${label}: مفيش طلبات. المبيعات المحصّلة ${m(0)}، والمرتجعات ${m(f.refundsMinor)}.`;
    return `${label}: ${fmtCount(f.orderCount)} طلب، والمبيعات المحصّلة ${m(f.salesMinor)} (من ${fmtCount(f.collectedOrders)} طلب مدفوع أو اتسلّم)، والمرتجعات ${m(f.refundsMinor)}${f.collectedOrders > 0 ? `، ومتوسط قيمة الطلب ${m(f.avgOrderMinor)}` : ''}.`;
  }
  if (f.orderCount === 0) return `${label}: no orders. Collected sales ${m(0)}, refunds ${m(f.refundsMinor)}.`;
  return `${label}: ${fmtCount(f.orderCount)} order${f.orderCount === 1 ? '' : 's'}, collected sales ${m(f.salesMinor)} (from ${fmtCount(f.collectedOrders)} paid or delivered), refunds ${m(f.refundsMinor)}${f.collectedOrders > 0 ? `, average order value ${m(f.avgOrderMinor)}` : ''}.`;
}

const ordersArgs = z.object({
  period: z.enum(ORDER_PERIODS).default('today').describe("'today' (النهارده), 'yesterday' (امبارح), 'this_week' (الأسبوع ده, from Saturday), 'last_7_days' (آخر 7 أيام) or 'this_month' (الشهر ده); default today"),
}).strict();
type OrdersAnswer = { currency: string; period: (typeof ORDER_PERIODS)[number]; orderCount: number; collectedOrders: number; salesMinor: number; refundsMinor: number; avgOrderMinor: number };

const ISO = z.string().datetime({ offset: true });
const DAY_MS = 86_400_000;
const couponArgs = z.object({
  type: z.enum(['percentage', 'fixed']).describe("'percentage' (a percent off) or 'fixed' (an amount off in the store currency)"),
  value: z.number().positive().describe(`percentage: a whole percent from 1 to ${COUPON_LIMITS.percentMax}; fixed: the amount in the store currency (up to ${COUPON_LIMITS.fixedMaxMinor / 100})`),
  durationDays: z.number().int().min(1).max(COUPON_LIMITS.windowDaysMax).optional().describe(`how many days it lasts, starting when the merchant confirms (1 to ${COUPON_LIMITS.windowDaysMax}); use this OR endsAt`),
  startsAt: ISO.optional().describe('optional start (ISO 8601 with offset); absent = starts when confirmed'),
  endsAt: ISO.optional().describe('optional end (ISO 8601 with offset); use this OR durationDays'),
  usageLimit: z.number().int().min(1).max(COUPON_LIMITS.usageLimitMax).optional().describe('optional total number of uses'),
  code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_-]+$/).optional().describe('optional code the shopper types (letters, digits, - and _); absent = one is generated'),
}).strict().superRefine((a, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if ((a.endsAt === undefined) === (a.durationDays === undefined)) bad('durationDays', 'give exactly one of durationDays / endsAt');
  if (a.type === 'percentage' && (!Number.isInteger(a.value) || a.value > COUPON_LIMITS.percentMax)) bad('value', `percentage must be a whole number 1-${COUPON_LIMITS.percentMax}`);
  if (a.type === 'fixed' && (Math.round(a.value * 100) > COUPON_LIMITS.fixedMaxMinor || Math.abs(a.value * 100 - Math.round(a.value * 100)) > 1e-6)) bad('value', 'fixed amount too large or has more than 2 decimals');
  if (a.startsAt && a.endsAt) {
    const span = Date.parse(a.endsAt) - Date.parse(a.startsAt);
    if (!(span > 0)) bad('endsAt', 'end must be after start');
    else if (span > COUPON_LIMITS.windowDaysMax * DAY_MS) bad('endsAt', `window longer than ${COUPON_LIMITS.windowDaysMax} days`);
  }
});
type CouponArgs = z.infer<typeof couponArgs>;

/** No 0/O/1/I/L: nothing a shopper can mistype or misread. */
const BASE32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TAIL = 10;
/**
 * The generated code must not be guessable (an outsider who could compute it could redeem it before the merchant shares it): the tail is an HMAC (key derived from a server secret,
 * domain-separated) over the store, the person, the terms and the day, 10 characters of an unambiguous alphabet (~5e14). The engine re-runs `preview` at the press and compares it
 * byte for byte, so the code cannot be random per call: it is a pure function of the secret and the inputs, hence identical on the card and at the confirm. The day is part of the
 * state the etag covers: a card held across midnight re-previews with the new code instead of creating a different one. Identical terms on the same day give the same code (one intent;
 * the Store answers a repeat with the coupon it already made). No secret = no generated code (the tool fails closed; the merchant can still give a code).
 */
async function generatedCode(secret: string | undefined, storeId: string, userId: string, a: CouponArgs, day: string): Promise<string> {
  if (!secret) throw new ToolInputError('unavailable');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(`coupon-code-v1|${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode([storeId, userId, a.type, a.value, a.durationDays ?? '', a.startsAt ?? '', a.endsAt ?? '', a.usageLimit ?? '', day].join('|'))));
  const tail = Array.from({ length: TAIL }, (_, i) => BASE32[mac[i]! % BASE32.length]).join('');
  return `${a.type === 'percentage' ? 'SALE' : 'SAVE'}${Math.round(a.value)}-${tail}`.slice(0, 24);
}

const when = (ms: number): string => new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'short' });

export function storeTools(kit: Kit): ToolSpec[] {
  const api = (ctx: TurnCtx): Reader => readerFor(kit.callApi, ctx);
  return [
    read(kit, {
      name: 'store_top_products', capabilityId: 'store.top-products', resultTrust: 'store-data',
      description: "The store's best-selling products for a period (today, last 7 days or last 30 days; default 30 days): name, units sold and revenue, top 1 to 10. Read live from the connected store; quote the numbers exactly as returned.",
      args: topArgs,
      run: async (ctx, a) => {
        const r = (await api(ctx).get('/store/top-products', { period: a.period, limit: String(a.limit) })) as TopAnswer;
        const items = r.items ?? [];
        return {
          period: r.period, periodDays: PERIOD_DAYS[r.period], currency: r.currency,
          products: items.map((p, i) => ({ rank: i + 1, name: ctx.locale === 'ar' ? (p.nameAr ?? p.name) : p.name, unitsSold: p.units, revenue: money(p.revenueMinor, r.currency) })),
          ...(items.length === 0 ? { note: 'no sales in this period' } : {}),
        };
      },
    }),

    read(kit, {
      name: 'store_orders_summary', capabilityId: 'store.orders-summary', resultTrust: 'store-data',
      description: "The store's orders and sales for a period (today, yesterday, this week from Saturday, last 7 days, this month): number of orders, sales collected (paid, or cash-on-delivery delivered), refunds, average order value. Owner only. Read live from the connected store; answer in the merchant's language and quote the figures exactly as returned.",
      args: ordersArgs,
      run: async (ctx, a) => {
        // Sales figures are the owner's alone: the answer says so instead of a failed read (the route would refuse a staff session anyway).
        if (ctx.role !== 'owner') return { available: false, reason: 'owner_only: only the store owner can see order and sales figures' };
        const r = (await api(ctx).get('/store/orders-summary', { period: a.period })) as OrdersAnswer;
        const m = (minor: number) => fmtMoney(minor, r.currency, ctx.locale);
        return {
          period: r.period, answerLanguage: ctx.locale,
          figures: { period: r.period, currency: r.currency, orderCount: r.orderCount, collectedOrders: r.collectedOrders, salesMinor: r.salesMinor, refundsMinor: r.refundsMinor, avgOrderMinor: r.avgOrderMinor } satisfies OrdersFigures,
          orders: fmtCount(r.orderCount), collectedOrders: fmtCount(r.collectedOrders),
          salesCollected: m(r.salesMinor), refunds: m(r.refundsMinor), averageOrderValue: r.collectedOrders > 0 ? m(r.avgOrderMinor) : 'n/a',
          definition: 'orders = orders placed in the period that count as sales; salesCollected = paid orders plus delivered cash-on-delivery orders, net of refunds; averageOrderValue = salesCollected / collectedOrders',
          ...(r.orderCount === 0 ? { note: 'no orders in this period' } : {}),
        };
      },
    }),

    writeTool<CouponArgs, { day: string; currency: string; storeId: string }>({
      name: 'store_create_coupon', capabilityId: 'store.coupon-create', policy: 'confirm', undo: 'irreversible', money: true,
      description: 'Create a discount coupon in the connected store: a percentage (1 to 90) or a fixed amount off, valid for a number of days (max 90) or until a date, with an optional usage limit and an optional code. Owner only. It never creates anything until the merchant presses confirm on the card.',
      args: couponArgs,
      read: async (reader, ctx) => {
        // Owner only (the route refuses anyone else): staff and operator sessions get no card to press instead of a card that fails on confirm.
        if (ctx.role !== 'owner') throw new ToolInputError('invalid');
        // The best-sellers read doubles as the liveness + currency check: a Store that cannot answer builds no card.
        const r = (await reader.get('/store/top-products', { period: 'today', limit: '1' })) as { currency?: string };
        if (!r.currency) throw new ToolInputError('unavailable');
        return { day: new Date(ctx.now).toISOString().slice(0, 10), currency: r.currency, storeId: ctx.storeId };
      },
      fingerprint: (s) => ({ day: s.day, currency: s.currency }),
      plan: async (a, s, ctx) => {
        const minor = a.type === 'fixed' ? Math.round(a.value * 100) : a.value;
        const end = a.endsAt ? Date.parse(a.endsAt) : ctx.now + (a.durationDays ?? 0) * DAY_MS;
        const begins = a.startsAt ? Date.parse(a.startsAt) : ctx.now;
        if (!(end > begins) || end - begins > COUPON_LIMITS.windowDaysMax * DAY_MS || end <= ctx.now) throw new ToolInputError('invalid');
        const code = (a.code ?? (await generatedCode(kit.codeSecret, s.storeId, ctx.userId, a, s.day))).toUpperCase();
        const off = a.type === 'percentage' ? `${a.value}%` : money(minor, s.currency);
        const windowText = a.durationDays !== undefined && !a.startsAt
          ? { ar: `يبدأ لما تأكد، ويستمر ${a.durationDays} يوم`, en: `Starts when you confirm, lasts ${a.durationDays} day(s)` }
          : { ar: `من ${when(begins)} إلى ${when(end)}`, en: `${when(begins)} to ${when(end)}` };
        return {
          summary: { ar: `إنشاء كوبون خصم ${off} بالكود ${code}`, en: `Create a ${off} discount coupon, code ${code}` },
          rows: [
            row('الكود', 'Code', undefined, code),
            row('الخصم', 'Discount', undefined, off),
            row('المدة', 'Window', undefined, `${windowText.ar} / ${windowText.en}`),
            row('عدد مرات الاستخدام', 'Usage limit', undefined, a.usageLimit !== undefined ? String(a.usageLimit) : 'من غير حد / unlimited'),
            row('بيتطبق على', 'Applies to', undefined, 'كل العملاء وكل المنتجات / all shoppers, all products'),
          ],
          request: {
            method: 'POST', path: '/store/coupons',
            body: { code, type: a.type, value: minor, ...(a.startsAt ? { startsAt: a.startsAt } : {}), ...(a.endsAt ? { endsAt: a.endsAt } : { durationDays: a.durationDays }), ...(a.usageLimit !== undefined ? { usageLimit: a.usageLimit } : {}) },
          },
          changesPrice: true,
        };
      },
      // The write key belongs to the PREVIEW (`stableUuid`): a crashed apply retried on a fresh approval of the same preview derives the same key, and the Store answers with the coupon it already made.
      send: async (call, plan, _a, ctx) => call({ ...plan.request, body: { ...(plan.request.body as object), idempotencyKey: await stableUuid(ctx, { method: 'POST', path: '/store/coupons' }) } }),
    }, kit),
  ];
}
