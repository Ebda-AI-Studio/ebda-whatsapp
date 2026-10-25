import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiSource } from './api';

const STORE = '11111111-1111-4111-8111-111111111111';
const wallet = {
  balanceMinor: 18500, heldMinor: 2500, availableMinor: 16000, debtMinor: 0, creditLimitMinor: 5000, currency: 'EGP',
  funding: [{ phoneNumberId: 'pn1', displayPhone: '+20 100 555 0101', funding: 'merchant_card' }], topupsEnabled: true, lowBalance: false,
  aiCredits: { balance: 10, available: 8 }, plan: { packageId: 'growth', status: 'active', periodEnd: 1, cancelledAt: null },
};

function stub(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown; raw?: string }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key]!(init);
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status, headers: { 'content-type': r.raw ? 'text/csv' : 'application/json' } });
  });
  const src = createApiSource({ baseUrl: 'https://wa.test', storeId: STORE, getToken: async () => 'tok', fetchImpl: f as unknown as typeof fetch, userNames: {}, currentUserId: 'u' });
  return { src, calls };
}
const auth = (c: { init?: RequestInit }) => new Headers(c.init?.headers).get('authorization');

afterEach(() => vi.restoreAllMocks());

describe('live wallet API', () => {
  it('reads the wallet with the bearer token and validates it against the contract', async () => {
    const { src, calls } = stub({ '/wallet': () => ({ status: 200, body: wallet }) });
    expect((await src.wallet!.wallet()).availableMinor).toBe(16000);
    expect(calls[0]!.url).toBe(`https://wa.test/api/v1/stores/${STORE}/wallet`);
    expect(auth(calls[0]!)).toBe('Bearer tok');
  });

  it('refuses a wallet response that breaks the contract', async () => {
    const { src } = stub({ '/wallet': () => ({ status: 200, body: { ...wallet, balanceMinor: 'lots' } }) });
    await expect(src.wallet!.wallet()).rejects.toThrow(/contract/);
  });

  it('asks for a month’s statement and downloads the CSV with the token, returning a blob URL', async () => {
    const { src, calls } = stub({
      'format=csv': () => ({ status: 200, body: null, raw: 'date,kind\n' }),
      '/wallet/statement': () => ({ status: 200, body: { month: '2026-10', from: 1, to: 2, openingMinor: 0, closingMinor: 0, rows: [], truncated: false, totalsByKind: {}, totalsByCategory: {}, cardCosts: [] } }),
    });
    expect((await src.wallet!.statement('2026-10')).month).toBe('2026-10');
    expect(calls[0]!.url).toContain('/wallet/statement?month=2026-10');
    const make = vi.fn(() => 'blob:csv-1');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: make }));
    expect(await src.wallet!.statementCsv('2026-10')).toBe('blob:csv-1');
    expect(calls[1]!.url).toContain('format=csv');
    expect(auth(calls[1]!)).toBe('Bearer tok');
    vi.unstubAllGlobals();
  });

  it('a refused CSV (403 for staff) is a typed error, not a blob', async () => {
    const { src } = stub({ 'format=csv': () => ({ status: 403, body: { error: 'forbidden' } }) });
    await expect(src.wallet!.statementCsv('2026-10')).rejects.toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('starts a top-up with exact piasters and returns the order with its fee', async () => {
    const { src, calls } = stub({ '/wallet/topups': () => ({ status: 201, body: { orderId: 'o1', state: 'pending', amountMinor: 20000, feeMinor: 800, totalMinor: 20800, checkoutUrl: 'https://pay.test/o1' } }) });
    const o = await src.wallet!.topup(20000);
    expect(o).toMatchObject({ orderId: 'o1', totalMinor: 20800 });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ amountMinor: 20000 });
    expect(calls[0]!.init?.method).toBe('POST');
  });

  it('a disabled or unavailable top-up surfaces as a typed 503', async () => {
    const { src } = stub({ '/wallet/topups': () => ({ status: 503, body: { error: 'rate_limited', message: 'disabled' } }) });
    await expect(src.wallet!.topup(20000)).rejects.toMatchObject({ status: 503, detail: 'disabled' });
  });

  it('reads an order’s state without crediting anything', async () => {
    const { src, calls } = stub({ '/wallet/topups/o1': () => ({ status: 200, body: { orderId: 'o1', state: 'paid', amountMinor: 1, feeMinor: 0, totalMinor: 1 } }) });
    expect((await src.wallet!.topupState('o1')).state).toBe('paid');
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
  });

  it('lists and creates refund requests, carrying the server’s reason on a refusal', async () => {
    const req = { id: 'r1', workspaceId: 'w', amountMinor: 5000, note: null, state: 'pending', requestedBy: 'u', createdAt: 1, decidedBy: null, decidedAt: null, decisionNote: null, cardRefundedMinor: 0, manualMinor: 0 };
    const { src, calls } = stub({ '/wallet/refund-requests': (init) => (init?.method === 'POST' ? { status: 409, body: { error: 'invalid_request', message: 'plan_still_active' } } : { status: 200, body: { items: [req] } }) });
    expect(await src.wallet!.refundRequests()).toHaveLength(1);
    await expect(src.wallet!.requestRefund(5000, '  ')).rejects.toMatchObject({ status: 409, detail: 'plan_still_active' });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ amountMinor: 5000 });
  });
});

describe('live operator API', () => {
  const settings = { ver: 2, effectiveFrom: 10, marginBps: 1500, creditLimitMinor: 5000, fxBufferBps: 200, vatBps: 0, actor: 'u', reason: 'r' };

  it('talks to /api/v1/operator, not to the store, and validates lists', async () => {
    const { src, calls } = stub({ '/api/v1/operator/pricing-settings': () => ({ status: 200, body: { items: [settings] } }) });
    expect(await src.operator!.pricingSettings()).toEqual([settings]);
    expect(calls[0]!.url).toBe('https://wa.test/api/v1/operator/pricing-settings');
    expect(auth(calls[0]!)).toBe('Bearer tok');
  });

  it('validates the lists the server builds inline (rate cards, FX, adjustments)', async () => {
    const { src } = stub({
      '/operator/rate-cards': () => ({ status: 200, body: { items: [{ ver: 1, effectiveFrom: 1, rows: 3, publishedAt: 1, actor: 'u' }] } }),
      '/operator/fx-rates': () => ({ status: 200, body: { items: [{ ver: 1, effectiveFrom: 1, egpPerUsdMicros: 49_000_000, bufferBps: 100, publishedAt: 1, actor: 'u' }] } }),
      '/operator/adjustments': () => ({ status: 200, body: { items: [{ id: 'a', workspaceId: 'w', amountMinor: 1, reason: 'x', requestedBy: 'u', state: 'sideways', approvedBy: null, createdAt: 1, decidedAt: null }] } }),
    });
    expect((await src.operator!.rateCards())[0]!.rows).toBe(3);
    expect((await src.operator!.fxRates())[0]!.egpPerUsdMicros).toBe(49_000_000);
    await expect(src.operator!.adjustments()).rejects.toThrow(/contract/);
  });

  it('sends exact integers and the reason when publishing, and the 503 guard comes through as a typed error', async () => {
    const { src, calls } = stub({ '/operator/pricing-settings': () => ({ status: 503, body: { error: 'rate_limited', message: 'session_check_unavailable' } }) });
    const input = { effectiveFrom: 99, marginBps: 1250, creditLimitMinor: 7500, fxBufferBps: 150, vatBps: 1400, reason: 'سبب' };
    const err = await src.operator!.publishPricingSettings(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 503, detail: 'session_check_unavailable' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(input);
  });

  it('decides refunds and adjustments with the right verbs and paths; funding is a PUT', async () => {
    const req = { id: 'q 1', workspaceId: 'w', amountMinor: 5000, note: null, state: 'processing', requestedBy: 'u', createdAt: 1, decidedBy: 'a', decidedAt: 2, decisionNote: null, cardRefundedMinor: 5000, manualMinor: 0 };
    const adj = { id: 'a1', workspaceId: 'w', amountMinor: 100, reason: 'x', requestedBy: 'u', state: 'approved', approvedBy: 'v', createdAt: 1, decidedAt: 2 };
    const { src, calls } = stub({
      '/refund-requests/q%201/decision': () => ({ status: 200, body: req }),
      '/adjustments/a1/decision': () => ({ status: 200, body: adj }),
      '/numbers/pn1/funding': () => ({ status: 200, body: { phoneNumberId: 'pn1', funding: 'platform_line' } }),
    });
    expect((await src.operator!.decideRefund('q 1', 'approve', ' ok ')).state).toBe('processing');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ decision: 'approve', note: 'ok' });
    expect((await src.operator!.decideAdjustment('a1', 'approve')).state).toBe('approved');
    await src.operator!.setFunding('pn1', 'platform_line', 'سبب');
    expect(calls[2]!.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({ funding: 'platform_line', reason: 'سبب' });
  });
});
