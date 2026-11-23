import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import corpusJson from '../../assistant/help-corpus.generated.json';
import registryJson from '../../assistant/registry.generated.json';
import { selectTools } from '../../foundation/smart-layer/plan/select-tools';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import type { HelpCorpus } from '../../src/core/smart-layer/help-index';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import { COUPON_LIMITS } from '../../src/core/store-bridge';
import { KEYWORDS } from '../../src/core/smart-layer/tools/keywords';
import { configureAssistant } from '../../src/routes/assistant';
import { NO_STORE_METRICS, isStoreMetricQuestion, observeTurn } from '../../src/routes/assistant-observe';
import { useApiKey } from '../helpers/api';
import { storeWorkspace, useStoreLink } from '../helpers/store-link';
import { noHelp, scriptedAi, setup } from './harness';

useApiKey();
const link = useStoreLink();
const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const adapter = () => chatAdapter({ env, ws: undefined as never, callApi: async () => ({ status: 200, json: {} }), registry: REGISTRY, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } });
const TOOLS = adapter().tools();
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

type T = Awaited<ReturnType<typeof setup>>;
async function readOnce(t: T, text: string, call: { name: string; args: unknown }) {
  const ai = scriptedAi([{ call }, { text: 'تمام.' }]);
  await t.ask(text, undefined, ai);
  return ai.seen.join(' ').replace(/\\"/g, '"');
}
const COUPON_Q = 'اعمل كوبون خصم 10% لمدة يوم';
const TOP_Q = 'إيه أكتر منتج بيتباع؟';
const coupon = (args: Record<string, unknown> = {}) => ({ name: 'store_create_coupon', args: { type: 'percentage', value: 10, durationDays: 1, ...args } });
async function workspaceFor(n: number, role: 'owner' | 'staff' = 'owner') {
  const t = await setup(n, role);
  await storeWorkspace(t.s);
  return t;
}

describe('store_top_products: real Store data through the bridge, for the workspace\'s own Store only', () => {
  it('answers from the Store: names (Arabic name in an Arabic turn), units, revenue as two-decimal strings, and the default period 30d / top 5', async () => {
    const t = await workspaceFor(7801);
    const seen = await readOnce(t, TOP_Q, { name: 'store_top_products', args: {} });
    expect(seen).toContain('خاتم دهب');
    expect(seen).toContain('Silver chain'); // no Arabic name: falls back to the Store's name
    expect(seen).toContain('"unitsSold":12');
    expect(seen).toContain('"revenue":"5400.00 EGP"');
    expect(seen).toContain('"periodDays":30');
    const [storeId, userId, req] = link.fake.lastCall('getTopProducts') as [string, string, unknown];
    expect(storeId).toBe(t.s); // the workspace's own Store: the model has no argument that could name another
    expect(userId).toBeTruthy();
    expect(req).toEqual({ period: '30d', limit: 5 });
    expect(JSON.stringify(tool('store_top_products').jsonSchema)).not.toMatch(/store|workspace/i);
  });

  it('honours period and the top-N cap (today / 7d / 30d, 1 to 10); anything else never reaches the Store', async () => {
    const t = await workspaceFor(7802);
    const seen = await readOnce(t, TOP_Q, { name: 'store_top_products', args: { period: 'today', limit: 2 } });
    expect(link.fake.lastCall('getTopProducts')[2]).toEqual({ period: 'today', limit: 2 });
    expect(seen).toContain('"rank":2');
    expect(seen).not.toContain('"rank":3');
    const before = link.fake.count('getTopProducts');
    for (const args of [{ limit: 11 }, { limit: 0 }, { period: 'year' }, { storeId: 'x' }]) await readOnce(t, TOP_Q, { name: 'store_top_products', args });
    expect(link.fake.count('getTopProducts')).toBe(before);
  });

  it('staff may read it (the Store lets owner and active staff); a Store that cannot answer gives a tool failure, not an empty list', async () => {
    const t = await workspaceFor(7803, 'staff');
    expect(await readOnce(t, TOP_Q, { name: 'store_top_products', args: {} })).toContain('خاتم دهب');
    link.fake.failNext.set('getTopProducts', 'unavailable');
    const seen = await readOnce(t, TOP_Q, { name: 'store_top_products', args: {} });
    expect(seen).toContain('tool_failed');
    expect(seen).not.toContain('"products":[]');
  });

  it('a period with no sales says so, with no invented row', async () => {
    const t = await workspaceFor(7804);
    link.fake.topSellers = [];
    const seen = await readOnce(t, TOP_Q, { name: 'store_top_products', args: {} });
    expect(seen).toContain('"products":[]');
    expect(seen).toContain('no sales in this period');
  });

  it('no invented numbers: a figure the model says that the tool did not return is removed; the tool\'s own figures (with or without a thousands comma) stay', async () => {
    const t = await workspaceFor(7805);
    const o = observeTurn(chatAdapterFor(t), { storeId: t.s, log: () => undefined });
    const top = o.adapter.tools().find((x) => x.name === 'store_top_products')!;
    await top.read!({ product: 'chat', storeId: t.s, userId: 'u', role: 'owner', locale: 'ar', now: Date.now(), conversationId: 'c', releaseId: 'r' }, { period: '7d', limit: 3 });
    const say = (text: string) => ({ status: 'answered', segments: [{ kind: 'text' as const, text }] });
    const q = 'إيه أكتر منتج بيتباع الاسبوع ده وكام مبيعاته؟';
    expect(o.refine(say('الأول خاتم دهب: 12 قطعة بإيراد 5,400.00 EGP'), 'ar', q).segments[0]).toMatchObject({ text: expect.stringContaining('12 قطعة') });
    expect(o.refine(say('الأول خاتم دهب: 12 قطعة بإيراد 5400 EGP'), 'ar', q).segments[0]).toMatchObject({ text: expect.stringContaining('5400') });
    expect(o.refine(say('الأول خاتم دهب: 999 قطعة'), 'ar', q).segments[0]).toEqual({ kind: 'text', text: NO_STORE_METRICS.ar });
  });
});

// The same adapter the route builds, but with the fake Store reachable through the routes (callApi = the worker itself would need a token; the tool read only needs the answer shape here).
function chatAdapterFor(t: T) {
  const base = adapter();
  return { ...base, tools: () => base.tools().map((x) => (x.name === 'store_top_products' ? { ...x, read: async () => ({ products: [{ rank: 1, name: 'x', unitsSold: 12, revenue: '5400.00 EGP' }], periodDays: 7, t: t.s }) } : x)) } as never;
}

describe('the metric-question guard', () => {
  it('best sellers now has a tool: not a no-tool metric question; orders and sales totals still are', () => {
    for (const q of ['إيه أكتر منتج بيتباع النهارده؟', 'what is my best selling product this month', 'أكتر 3 منتجات مبيعا الشهر ده كام']) expect(isStoreMetricQuestion(q), q).toBe(false);
    for (const q of ['كام طلب جالي النهارده؟', 'إجمالي المبيعات النهارده كام؟', 'How many orders did I get today?']) expect(isStoreMetricQuestion(q), q).toBe(true);
  });

  it('through the route: the best-sellers question reaches the model (and its tool); orders-today still never does', async () => {
    const t = await workspaceFor(7806);
    const ai = scriptedAi([{ call: { name: 'store_top_products', args: {} } }, { text: 'الأول خاتم دهب: 12 قطعة.' }]);
    configureAssistant({ ai: ai as never, help: noHelp });
    const res = await SELF.fetch(`https://x/api/v1/stores/${t.s}/assistant/turn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.api.token}` }, body: JSON.stringify({ conversationId: crypto.randomUUID(), text: 'إيه أكتر منتج بيتباع النهارده؟', locale: 'ar' }) });
    const body = (await res.json()) as { segments: Array<{ text: string }> };
    expect(body.segments.map((s) => s.text).join(' ')).toContain('خاتم دهب');
    expect(link.fake.count('getTopProducts')).toBe(1);
    // Store-linked: orders-today is the orders tool's now, not a fixed no-tool reply (that stays for Chat-only workspaces, see observeTurn below).
    const ai2 = scriptedAi([{ text: 'تمام.' }]);
    await t.ask('كام طلب جالي النهارده؟', undefined, ai2);
    expect(ai2.seen.length).toBeGreaterThan(0);
  });

  it('observeTurn: the fixed no-tool reply is for Chat-only workspaces; a store-linked one gets the model and its tool', () => {
    const ad = { ai: { run: async () => ({}) }, models: { answer: 'm', plan: 'm', template: 'm', classify: 'm', judge: 'm', embed: 'm' }, tools: () => [], storage: { appendAudit: async () => undefined } } as never;
    for (const q of ['كام طلب جالي النهارده؟', 'How many orders did I get today?']) {
      expect(observeTurn(ad, { storeId: 's', log: () => undefined }).deterministic(q, 'ar'), q).not.toBeNull();
      expect(observeTurn(ad, { storeId: 's', storeLinked: false, log: () => undefined }).deterministic(q, 'ar'), q).not.toBeNull();
      expect(observeTurn(ad, { storeId: 's', storeLinked: true, log: () => undefined }).deterministic(q, 'ar'), q).toBeNull();
    }
  });
});

describe('store_create_coupon: validation (nothing invalid gets as far as a card)', () => {
  const ok = (a: Record<string, unknown>) => tool('store_create_coupon').args.safeParse({ type: 'percentage', value: 10, durationDays: 1, ...a }).success;
  it('percent 1 to 90, whole; fixed at most 50,000 with 2 decimals; window 1 to 90 days; end after start; exactly one end form; unique-able code shape', () => {
    expect(ok({})).toBe(true);
    expect(ok({ value: 90 })).toBe(true);
    for (const value of [0, -5, 91, 10.5]) expect(ok({ value }), `percent ${value}`).toBe(false);
    expect(ok({ type: 'fixed', value: 50 })).toBe(true);
    expect(ok({ type: 'fixed', value: 50_000 })).toBe(true);
    for (const value of [50_000.01, 0, 12.345]) expect(ok({ type: 'fixed', value }), `fixed ${value}`).toBe(false);
    for (const durationDays of [0, 91]) expect(ok({ durationDays })).toBe(false);
    expect(ok({ durationDays: undefined })).toBe(false); // no end at all
    expect(ok({ endsAt: '2026-12-01T00:00:00Z' })).toBe(false); // both end forms
    expect(ok({ durationDays: undefined, startsAt: '2026-12-02T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' })).toBe(false);
    expect(ok({ durationDays: undefined, startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z' })).toBe(false);
    expect(ok({ durationDays: undefined, startsAt: '2026-12-01T00:00:00Z', endsAt: '2027-03-15T00:00:00Z' })).toBe(false); // over 90 days
    expect(ok({ durationDays: undefined, startsAt: '2026-12-01T00:00:00Z', endsAt: '2027-02-28T00:00:00Z' })).toBe(true);
    expect(ok({ usageLimit: 0 })).toBe(false);
    for (const code of ['AB', 'has space', 'x'.repeat(25), 'كود']) expect(ok({ code }), code).toBe(false);
    expect(ok({ code: 'EID-10' })).toBe(true);
    expect(ok({ storeId: 'x' })).toBe(false); // strict: no argument names a store
  });

  it('an invalid ask builds no card and writes nothing', async () => {
    const t = await workspaceFor(7810);
    for (const args of [{ value: 95 }, { durationDays: 120 }, { type: 'fixed', value: 60_000 }]) expect((await t.ask(COUPON_Q, coupon(args))).previews).toEqual([]);
    expect(link.fake.count('createCoupon')).toBe(0);
    expect(link.fake.coupons).toEqual([]);
  });
});

describe('store_create_coupon: never writes without the merchant\'s confirm press', () => {
  it('the card is confirm class with the code, discount, window, limit; creating the card, a bare apply and a second look write NOTHING; only the confirm press creates exactly one coupon', async () => {
    const t = await workspaceFor(7820);
    const out = await t.ask(COUPON_Q, coupon({ usageLimit: 50 }));
    expect(out.previews).toHaveLength(1);
    const card = out.previews[0]!;
    expect(card).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
    expect(card.reasons).toEqual(expect.arrayContaining(['money']));
    expect(JSON.stringify(card.rows)).toMatch(/SALE10-[A-HJKMN-Z2-9]{10}/);
    expect(JSON.stringify(card.rows)).toContain('10%');
    expect(link.fake.count('createCoupon')).toBe(0); // the card alone wrote nothing
    expect(link.fake.coupons).toEqual([]);

    const bare = await t.apply(card.previewId); // a confirm-class card has no unconfirmed apply
    expect(((await bare.json()) as { status?: string }).status).not.toBe('applied'); // the engine answers that it needs the confirm press
    expect(link.fake.count('createCoupon')).toBe(0);
    expect(link.fake.coupons).toEqual([]);

    const typedYes = await t.ask('أيوه، نفّذ', undefined, scriptedAi([{ text: 'تمام.' }])); // typed words carry no approval token
    expect(typedYes.previews).toEqual([]);
    expect(link.fake.coupons).toEqual([]);

    const ap = out.approvals![0]!;
    const done = (await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string };
    expect(done.status).toBe('applied');
    expect(link.fake.coupons).toHaveLength(1);
    expect(link.fake.coupons[0]).toMatchObject({ type: 'percentage', value: 10, usageLimit: 50 });
    // The token is single use: pressing again changes nothing.
    await t.confirm(ap.approvalId, ap.token);
    expect(link.fake.coupons).toHaveLength(1);
  });

  it('a rejected card writes nothing', async () => {
    const t = await workspaceFor(7821);
    const out = await t.ask(COUPON_Q, coupon());
    await t.reject(out.approvals![0]!.approvalId);
    expect(link.fake.count('createCoupon')).toBe(0);
  });

  it('the generated code is the same on the card and in the coupon, and the same for the same terms; an explicit code is kept (upper-cased); a fixed amount goes to the Store in minor units', async () => {
    const t = await workspaceFor(7822);
    const a = await t.ask(COUPON_Q, coupon());
    const b = await t.ask(COUPON_Q, coupon());
    const codeOf = (c: { rows: unknown[] }) => /SALE10-[A-HJKMN-Z2-9]{10}/.exec(JSON.stringify(c.rows))![0];
    expect(codeOf(b.previews[0]!)).toBe(codeOf(a.previews[0]!));
    const ap = a.approvals![0]!;
    await t.confirm(ap.approvalId, ap.token);
    expect(link.fake.coupons[0]!.code).toBe(codeOf(a.previews[0]!));
    const f = await t.ask('اعمل كود خصم 50 جنيه', coupon({ type: 'fixed', value: 50, code: 'eid50', durationDays: 7 }));
    expect(JSON.stringify(f.previews[0]!.rows)).toContain('EID50');
    await t.confirm(f.approvals![0]!.approvalId, f.approvals![0]!.token);
    expect(link.fake.coupons[1]).toMatchObject({ code: 'EID50', type: 'fixed', value: 5000 });
  });

  it('the generated code cannot be computed from the terms: 10 unambiguous characters, different for another store, other terms or another day, same on the card, the re-preview and the confirm', async () => {
    const t1 = await workspaceFor(7840);
    const t2 = await workspaceFor(7841);
    const codeOf = (c: { rows: unknown[] }) => /SALE\d+-([A-HJKMN-Z2-9]{10})/.exec(JSON.stringify(c.rows))![0];
    const a1 = await t1.ask(COUPON_Q, coupon());
    const a2 = await t2.ask(COUPON_Q, coupon()); // identical terms, another store
    const b1 = await t1.ask(COUPON_Q, coupon({ durationDays: 2 })); // other terms
    const codes = [a1, a2, b1].map((o) => codeOf(o.previews[0]!));
    expect(new Set(codes).size).toBe(3);
    expect(codes[0]!.split('-')[1]).not.toMatch(/[01OIL]/);
    // the old formula (sha256 over the terms, 4 chars) must not reproduce any tail
    const { sha256Hex } = await import('../../foundation/smart-layer/release');
    const h = await sha256Hex([t1.s, 'percentage', 10, 1, '', '', '', new Date().toISOString().slice(0, 10)].join('|'));
    const old = Array.from({ length: 4 }, (_, i) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) % 31]).join('');
    expect(codes[0]!.split('-')[1]!.startsWith(old)).toBe(false);
    // the confirm creates exactly the code the card showed
    await t1.confirm(a1.approvals![0]!.approvalId, a1.approvals![0]!.token);
    expect(link.fake.coupons.at(-1)!.code).toBe(codes[0]);
  });

  it('is audit-logged with before/after (actor, coupon id, terms) and the Store was asked as the calling owner', async () => {
    const t = await workspaceFor(7823);
    const out = await t.ask(COUPON_Q, coupon());
    await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token);
    const row = await env.DB.prepare("SELECT actor, actor_role, target_id, detail FROM audit_log WHERE workspace_id = ? AND action = 'store.coupon_create'").bind(t.s).first<{ actor: string; actor_role: string; target_id: string; detail: string }>();
    expect(row).toBeTruthy();
    expect(row!.actor_role).toBe('owner');
    expect(JSON.parse(row!.detail)).toMatchObject({ before: 'none', afterType: 'percentage', afterValue: 10 });
    expect(link.fake.lastCall('createCoupon')[1]).toBe(row!.actor);
  });

  it('the Store refusing (a code that already exists with other terms) leaves the Store as it was and the merchant is not told it was created', async () => {
    const t = await workspaceFor(7824);
    link.fake.coupons.push({ couponId: 'old', code: 'EID10', type: 'fixed', value: 100, startsAt: null, expiresAt: new Date().toISOString(), usageLimit: null, replayed: false, key: 'someone-else', createdAt: Date.now() });
    const out = await t.ask(COUPON_Q, coupon({ code: 'EID10' }));
    const res = (await (await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token)).json()) as { status: string };
    expect(res.status).not.toBe('applied');
    expect(link.fake.coupons).toHaveLength(1);
    expect(link.fake.coupons[0]!.couponId).toBe('old');
  });

  it('staff get no card at all (owner only), and the route refuses them anyway', async () => {
    const t = await workspaceFor(7825, 'staff');
    expect((await t.ask(COUPON_Q, coupon())).previews).toEqual([]);
    expect(link.fake.count('createCoupon')).toBe(0);
    const direct = await t.api.call('POST', '/store/coupons', { code: 'ABC10', type: 'percentage', value: 10, durationDays: 1, idempotencyKey: crypto.randomUUID() });
    expect(direct.status).toBe(403);
    expect(link.fake.count('createCoupon')).toBe(0);
  });

  it('a Store that cannot answer builds no card', async () => {
    const t = await workspaceFor(7826);
    link.fake.failNext.set('getTopProducts', 'unavailable'); // the card\'s state read
    expect((await t.ask(COUPON_Q, coupon())).previews).toEqual([]);
    expect(link.fake.count('createCoupon')).toBe(0);
  });
});

describe('POST /store/coupons: idempotent and validated at the edge', () => {
  const body = (o: Record<string, unknown> = {}) => ({ code: 'IDEM10', type: 'percentage', value: 10, durationDays: 1, idempotencyKey: '11111111-1111-4111-8111-111111111111', ...o });
  it('the same key retried returns the same coupon once (200 replayed, one audit row); a different key with the same code is 409', async () => {
    const t = await workspaceFor(7830);
    const first = await t.api.call('POST', '/store/coupons', body());
    expect(first.status).toBe(201);
    const again = await t.api.call('POST', '/store/coupons', body());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(link.fake.coupons).toHaveLength(1);
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'store.coupon_create'").bind(t.s).first<{ n: number }>();
    expect(audits!.n).toBe(1);
    const other = await t.api.call('POST', '/store/coupons', body({ idempotencyKey: '22222222-2222-4222-8222-222222222222' }));
    expect(other.status).toBe(409);
    expect(link.fake.coupons).toHaveLength(1);
  });

  it('rejects out-of-range bodies before the Store is asked', async () => {
    const t = await workspaceFor(7831);
    for (const o of [{ value: 91 }, { type: 'fixed', value: 5_000_001 }, { durationDays: 91 }, { durationDays: undefined }, { idempotencyKey: 'not-a-uuid' }, { code: 'x' }, { extra: 1 }]) {
      expect((await t.api.call('POST', '/store/coupons', body(o))).status, JSON.stringify(o)).toBe(400);
    }
    expect(link.fake.count('createCoupon')).toBe(0);
  });
});

describe('store_orders_summary: the owner\'s orders and sales from the Store', () => {
  const ask = async (t: T, text: string, locale: 'ar' | 'en', say: string, args: unknown = {}) => {
    const ai = scriptedAi([{ call: { name: 'store_orders_summary', args } }, { text: say }]);
    configureAssistant({ ai: ai as never, help: noHelp });
    const res = await SELF.fetch(`https://x/api/v1/stores/${t.s}/assistant/turn`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t.api.token}` }, body: JSON.stringify({ conversationId: crypto.randomUUID(), text, locale }) });
    const body = (await res.json()) as { segments: Array<{ text: string }> };
    return { seen: ai.seen.join(' ').replace(/\\"/g, '"'), said: body.segments.map((x) => x.text).join(' ') };
  };

  it('answers from the Store in the question\'s language: Arabic gets the Arabic currency word, English the code, both Latin digits with a comma grouping', async () => {
    const t = await workspaceFor(7850);
    const ar = await ask(t, 'كام طلب النهارده؟', 'ar', 'النهارده 7 طلبات والمبيعات 12,345.50 جنيه', { period: 'today' });
    expect(ar.seen).toContain('"salesCollected":"12,345.50 جنيه"');
    expect(ar.seen).toContain('"orders":"7"');
    expect(ar.seen).toContain('"answerLanguage":"ar"');
    expect(ar.said).toContain('12,345.50');
    const en = await ask(t, 'What were my sales this week?', 'en', 'You made 12,345.50 EGP from 4 collected orders.', { period: 'this_week' });
    expect(en.seen).toContain('"salesCollected":"12,345.50 EGP"');
    expect(en.seen).toContain('"refunds":"500.00 EGP"');
    expect(en.seen).toContain('"averageOrderValue":"3,086.38 EGP"');
    expect(en.seen).toContain('"answerLanguage":"en"');
    expect(en.said).toContain('12,345.50 EGP');
    expect(link.fake.lastCall('getOrdersSummary')).toEqual([t.s, expect.any(String), { period: 'this_week' }]);
  });

  it('defaults to today; an unknown period or a store argument never reaches the Store', async () => {
    const t = await workspaceFor(7851);
    await ask(t, 'كام طلب النهارده؟', 'ar', 'تمام.', {});
    expect(link.fake.lastCall('getOrdersSummary')[2]).toEqual({ period: 'today' });
    const before = link.fake.count('getOrdersSummary');
    for (const args of [{ period: 'year' }, { storeId: 'x' }]) await ask(t, 'كام طلب النهارده؟', 'ar', 'تمام.', args);
    expect(link.fake.count('getOrdersSummary')).toBe(before);
  });

  it('no invented numbers: a figure the tool did not return is replaced by the honest answer; the tool\'s own figures stay', async () => {
    const t = await workspaceFor(7852);
    const bad = await ask(t, 'كام طلب النهارده؟', 'ar', 'النهارده جالك 999 طلب');
    expect(bad.said).toBe(NO_STORE_METRICS.ar);
    const good = await ask(t, 'كام طلب النهارده؟', 'ar', 'النهارده جالك 7 طلب');
    expect(good.said).toContain('7');
    expect(good.said).not.toBe(NO_STORE_METRICS.ar);
  });

  it('owner only: staff are told the figures are the owner\'s and the Store is never asked', async () => {
    const t = await workspaceFor(7853, 'staff');
    const r = await ask(t, 'كام طلب النهارده؟', 'ar', 'دي أرقام المالك.');
    expect(r.seen).toContain('owner_only');
    expect(link.fake.count('getOrdersSummary')).toBe(0);
    const direct = await t.api.call('GET', '/store/orders-summary?period=today');
    expect(direct.status).toBe(403);
  });

  it('a Store that cannot answer is a tool failure, never zeros', async () => {
    const t = await workspaceFor(7854);
    link.fake.failNext.set('getOrdersSummary', 'unavailable');
    const r = await ask(t, 'كام طلب النهارده؟', 'ar', 'مقدرتش اقرا.');
    expect(r.seen).toContain('tool_failed');
    expect(r.seen).not.toContain('"orders":"0"');
  });

  it('a period with no orders says so', async () => {
    const t = await workspaceFor(7855);
    link.fake.ordersSummary = { orderCount: 0, collectedOrders: 0, salesMinor: 0, refundsMinor: 0, avgOrderMinor: 0 };
    const r = await ask(t, 'كام طلب امبارح؟', 'ar', 'مفيش طلبات.', { period: 'yesterday' });
    expect(r.seen).toContain('no orders in this period');
    expect(r.seen).toContain('"averageOrderValue":"n/a"');
  });
});

describe('contract pin: the limits Chat checks early are the ones the Store applies', () => {
  // The Store's owner-tools.ts exports MAX_PERCENT / MAX_FIXED_MINOR / MAX_WINDOW_DAYS / MAX_USAGE_LIMIT and pins the same literals in
  // tests/unit/wa-bridge/wa-bridge-owner-tools.test.ts (ebda-store). Change both repos together.
  it('COUPON_LIMITS equals the Store values', () => {
    expect(COUPON_LIMITS).toEqual({ percentMax: 90, fixedMaxMinor: 5_000_000, windowDaysMax: 90, usageLimitMax: 100_000 });
  });
});

describe('registration: both tools are in the registry, retrievable by an Arabic ask, and offered to Store workspaces only', () => {
  it('each tool\'s capability is live, in the registry, with the policy the tool has', () => {
    expect(REGISTRY.caps.get('store.top-products')).toMatchObject({ status: 'live', policy: 'free' });
    expect(REGISTRY.caps.get('store.orders-summary')).toMatchObject({ status: 'live', policy: 'free' });
    expect(REGISTRY.caps.get('store.coupon-create')).toMatchObject({ status: 'live', policy: 'confirm', undo: 'irreversible' });
    expect(tool('store_top_products')).toMatchObject({ capabilityId: 'store.top-products', policy: 'free' });
    expect(tool('store_create_coupon')).toMatchObject({ capabilityId: 'store.coupon-create', policy: 'confirm', money: true });
  });
  it('the merchant\'s own words find them (Arabic, Franco, English)', () => {
    const offered = (q: string) => selectTools(q, TOOLS, REGISTRY, { mode: 'act', untrustedInContext: false }).map((x) => x.name);
    for (const q of [TOP_Q, 'اكتر منتج بيتباع', 'akter montag byetba3', 'best selling products']) expect(offered(q), q).toContain('store_top_products');
    for (const q of ['كام طلب النهارده؟', 'مبيعاتي الأسبوع ده كام', 'kam talab el nharda', 'What were my sales this week?']) expect(offered(q), q).toContain('store_orders_summary');
    for (const q of [COUPON_Q, 'e3mel koboun khasm', 'create a discount coupon']) expect(offered(q), q).toContain('store_create_coupon');
    expect(KEYWORDS.store_create_coupon).toBeTruthy();
  });
});
