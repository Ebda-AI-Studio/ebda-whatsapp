import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { configurePayments, type PaymentProvider } from '../src/core/billing/payments';
import { OP1, OP2, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { fund, ledger } from './helpers/billing';
import { rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const json = async (r: Response) => (await r.json()) as Record<string, unknown> & { items?: Record<string, unknown>[] };
beforeEach(() => configureSessionCheck(async () => false)); // healthy accounts service: no session is revoked
afterEach(() => configureSessionCheck(null));
afterEach(() => configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? null : null)));

describe('operator access', () => {
  it('needs a super admin: no token 401, a store owner 403', async () => {
    expect((await operatorCall(null, 'GET', '/pricing-settings')).status).toBe(401);
    const owner = await apiFor(W(1000));
    const r = await fetch_(owner.token);
    expect(r.status).toBe(403);
    expect((await operatorCall(OP1, 'GET', '/pricing-settings')).status).toBe(200);
  });
  const fetch_ = (token: string) => import('cloudflare:test').then(({ SELF }) => SELF.fetch('https://x/api/v1/operator/pricing-settings', { headers: { authorization: `Bearer ${token}` } }));
});

describe('WA-MARGIN-1: pricing settings', () => {
  it('a change needs a reason, is dated at least an hour ahead, becomes a NEW version, and is audited old -> new', async () => {
    const list0 = await json(await operatorCall(OP1, 'GET', '/pricing-settings'));
    expect(list0.items!.at(-1)).toMatchObject({ ver: 1, marginBps: 0, creditLimitMinor: 5000 });
    const body = { marginBps: 1500, creditLimitMinor: 5000, fxBufferBps: 200, vatBps: 0 };
    expect((await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, reason: 'x' })).status).toBe(400); // reason too short
    expect((await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, reason: 'covers FX risk', effectiveFrom: Date.now() + 60_000 })).status).toBe(400); // not an hour ahead
    expect((await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, marginBps: 999_999, reason: 'covers FX risk' })).status).toBe(400);
    const ok = await operatorCall(OP1, 'POST', '/pricing-settings', { ...body, reason: 'covers FX risk' });
    expect(ok.status).toBe(201);
    const v = await json(ok);
    expect(v).toMatchObject({ ver: 2, marginBps: 1500, fxBufferBps: 200, actor: OP1, reason: 'covers FX risk' });
    expect(v.effectiveFrom as number).toBeGreaterThan(Date.now() + HOUR - 10_000);
    const log = await json(await operatorCall(OP1, 'GET', '/change-log?limit=5'));
    expect(log.items![0]).toMatchObject({ action: 'pricing_settings_published', actor: OP1, reason: 'covers FX risk', before: { marginBps: 0 }, after: { ver: 2, marginBps: 1500 } });
    await expect(env.DB.prepare('UPDATE pricing_settings SET margin_bps = 0 WHERE ver = 2').run()).rejects.toThrow(/immutable/);
  });

  it('a per-workspace override is its own versioned row for a known workspace only', async () => {
    const ws = W(1001);
    await seedNumber('pn-op1001', ws);
    expect((await operatorCall(OP1, 'POST', `/pricing-overrides/${W(1999)}`, { marginBps: 500, reason: 'launch deal' })).status).toBe(404);
    const r = await operatorCall(OP1, 'POST', `/pricing-overrides/${ws}`, { marginBps: 500, reason: 'launch deal' });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ver: 1, marginBps: 500 });
    expect((await json(await operatorCall(OP1, 'POST', `/pricing-overrides/${ws}`, { marginBps: 400, reason: 'second deal' }))).ver).toBe(2);
    expect((await json(await operatorCall(OP1, 'GET', `/pricing-overrides/${ws}`))).items).toHaveLength(2);
    expect((await json(await operatorCall(OP1, 'GET', '/change-log?limit=1'))).items![0]).toMatchObject({ action: 'pricing_override_published', workspaceId: ws });
  });
});

describe('rate cards, FX and number funding', () => {
  it('rate cards and FX must be published at least 24 h ahead; each publish is a new version', async () => {
    const rates = [{ country: 'EG', category: 'marketing', usdMicros: 52_000 }, { country: 'EG', category: 'utility', usdMicros: 14_000 }];
    expect((await operatorCall(OP1, 'POST', '/rate-cards', { effectiveFrom: Date.now() + 2 * HOUR, rates, reason: 'Meta update' })).status).toBe(400);
    const ok = await operatorCall(OP1, 'POST', '/rate-cards', { effectiveFrom: Date.now() + 25 * HOUR, rates, reason: 'Meta update' });
    expect(ok.status).toBe(201);
    const first = await json(ok);
    expect(first).toMatchObject({ rows: 2 });
    const second = await json(await operatorCall(OP1, 'POST', '/rate-cards', { effectiveFrom: Date.now() + 26 * HOUR, rates: [rates[0]!, rates[0]!], reason: 'dedupe check' }));
    expect(second).toMatchObject({ ver: (first.ver as number) + 1, rows: 1 }); // a repeated (country, category) in one card is one row
    expect((await json(await operatorCall(OP1, 'GET', '/rate-cards'))).items![0]).toMatchObject({ ver: second.ver });
    expect((await operatorCall(OP1, 'POST', '/fx-rates', { effectiveFrom: Date.now() + HOUR, egpPerUsdMicros: 49_500_000, reason: 'new rate' })).status).toBe(400);
    const fx = await operatorCall(OP1, 'POST', '/fx-rates', { effectiveFrom: Date.now() + 25 * HOUR, egpPerUsdMicros: 49_500_000, bufferBps: 100, reason: 'new rate' });
    expect(fx.status).toBe(201);
    expect((await json(await operatorCall(OP1, 'GET', '/fx-rates'))).items![0]).toMatchObject({ egpPerUsdMicros: 49_500_000, bufferBps: 100, actor: OP1 });
  });

  it("number funding: the plan's legacy name is stored under the neutral one; an unknown number is 404; the change is audited", async () => {
    const ws = W(1010);
    await seedNumber('pn-op1010', ws);
    expect((await operatorCall(OP1, 'PUT', '/numbers/pn-nobody/funding', { funding: 'platform_line', reason: 'shared number' })).status).toBe(404);
    expect((await operatorCall(OP1, 'PUT', '/numbers/pn-op1010/funding', { funding: 'cash', reason: 'shared number' })).status).toBe(400);
    const r = await operatorCall(OP1, 'PUT', '/numbers/pn-op1010/funding', { funding: 'ebda_line', reason: 'shared number' });
    expect(await r.json()).toEqual({ phoneNumberId: 'pn-op1010', funding: 'platform_line' });
    expect(await env.DB.prepare("SELECT funding FROM number_funding WHERE phone_number_id = 'pn-op1010'").first()).toEqual({ funding: 'platform_line' });
    expect((await json(await operatorCall(OP1, 'GET', '/change-log?limit=1'))).items![0]).toMatchObject({ action: 'number_funding_set', before: { funding: 'merchant_card' }, after: { funding: 'platform_line' } });
  });
});

describe('adjustments: actor and reason always; a second approver above the threshold', () => {
  it('a small one is applied at once with the actor and reason on the row', async () => {
    const ws = W(1020);
    await seedNumber('pn-op1020', ws);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 500, reason: 'ok' })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 0, reason: 'nothing at all' })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${W(1998)}/adjustments`, { amountMinor: 500, reason: 'goodwill credit' })).status).toBe(404);
    const r = await json(await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 500, reason: 'goodwill credit' }));
    expect(r).toMatchObject({ state: 'approved', requestedBy: OP1 });
    expect(await rows(ws, "SELECT kind, amount_minor, actor, note, ref FROM wallet_ledger")).toEqual([{ kind: 'adjustment', amount_minor: 500, actor: OP1, note: 'goodwill credit', ref: `adj:${r.id}` }]);
  });

  it('a large one waits for a DIFFERENT super admin; the requester cannot approve it; a rejection posts nothing; a decision is final', async () => {
    const ws = W(1021);
    await seedNumber('pn-op1021', ws);
    const big = await json(await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: -150_000, reason: 'chargeback dispute' }));
    expect(big.state).toBe('pending');
    expect(await ledger(ws)).toEqual([]);
    expect((await operatorCall(OP1, 'POST', `/adjustments/${big.id}/decision`, { decision: 'approve' })).status).toBe(403);
    expect((await operatorCall(OP2, 'POST', `/adjustments/${big.id}/decision`, { decision: 'approve' })).status).toBe(200);
    expect((await operatorCall(OP2, 'POST', `/adjustments/${big.id}/decision`, { decision: 'approve' })).status).toBe(409);
    expect(await rows(ws, 'SELECT kind, amount_minor, actor FROM wallet_ledger')).toEqual([{ kind: 'adjustment', amount_minor: -150_000, actor: OP1 }]);
    const other = await json(await operatorCall(OP1, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 200_000, reason: 'bulk goodwill' }));
    expect((await operatorCall(OP2, 'POST', `/adjustments/${other.id}/decision`, { decision: 'reject' })).status).toBe(200);
    expect((await ledger(ws)).length).toBe(1);
    expect((await json(await operatorCall(OP1, 'GET', '/adjustments?state=pending'))).items!.some((a) => a.id === other.id)).toBe(false);
    expect((await operatorCall(OP2, 'POST', '/adjustments/nope/decision', { decision: 'approve' })).status).toBe(404);
  });
});

describe('WA-REFUND-1: the refund queue', () => {
  async function cancelledWorkspace(n: number, balance: number, opts: { periodEndedDaysAgo?: number; status?: 'cancelled' | 'active' } = {}) {
    const ws = W(n);
    await seedNumber(`pn-op${n}`, ws);
    const end = Date.now() - (opts.periodEndedDaysAgo ?? 2) * DAY;
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'p', status: opts.status ?? 'cancelled', periodStart: end - 30 * DAY, periodEnd: end, cancelledAt: end - DAY });
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES (?, ?, ?, 0, ?, 'EGP', 'paid', 'u', 1, ?, ?)")
      .bind(`o-${n}`, ws, balance, balance, `TX-${n}`, 5).run();
    await fund(ws, balance, `kashier:TX-${n}`);
    return ws;
  }
  const provider = (ok: boolean): PaymentProvider => ({ name: 'fake', createSession: async () => ({ checkoutUrl: 'https://x' }), verifyWebhook: async () => null, confirm: async (e: unknown) => e as never, confirmationReady: () => true, inquire: async () => 'unsupported', refund: async () => (ok ? { ok: true, refundId: 'R1' } : { ok: false, reason: 'unsupported' }) });

  it('the owner can ask only after the plan period ended and within 12 months, for at least 50 EGP and no more than the balance', async () => {
    const active = await cancelledWorkspace(1030, 20_000, { status: 'active', periodEndedDaysAgo: -5 });
    expect((await (await apiFor(active)).call('POST', '/wallet/refund-requests', { amountMinor: 10_000 })).status).toBe(409);
    const notEnded = W(1031);
    await seedNumber('pn-op1031', notEnded);
    await workspace(notEnded).applyEntitlement({ version: 1, packageId: 'p', status: 'cancelled', periodStart: Date.now() - DAY, periodEnd: Date.now() + 5 * DAY, cancelledAt: Date.now() - DAY });
    await fund(notEnded, 20_000);
    const nr = await (await apiFor(notEnded)).call('POST', '/wallet/refund-requests', { amountMinor: 10_000 });
    expect(await nr.json()).toMatchObject({ message: 'period_not_ended' });
    const old = await cancelledWorkspace(1032, 20_000, { periodEndedDaysAgo: 400 });
    expect(await (await (await apiFor(old)).call('POST', '/wallet/refund-requests', { amountMinor: 10_000 })).json()).toMatchObject({ message: 'window_passed' });
    const ws = await cancelledWorkspace(1033, 20_000);
    const api = await apiFor(ws);
    expect((await api.call('POST', '/wallet/refund-requests', { amountMinor: 4_999 })).status).toBe(400); // under 50 EGP: refused by the contract
    expect(await (await api.call('POST', '/wallet/refund-requests', { amountMinor: 25_000 })).json()).toMatchObject({ message: 'exceeds_refundable' });
    expect((await (await apiFor(ws, 'staff')).call('POST', '/wallet/refund-requests', { amountMinor: 10_000 })).status).toBe(403);
    const ok = await api.call('POST', '/wallet/refund-requests', { amountMinor: 12_000, note: 'closing the shop' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ amountMinor: 12_000, state: 'pending', workspaceId: ws });
    // what is already asked for is not available twice
    expect(await (await api.call('POST', '/wallet/refund-requests', { amountMinor: 9_000 })).json()).toMatchObject({ message: 'exceeds_refundable' });
    expect(((await json(await api.call('GET', '/wallet/refund-requests'))).items ?? []).length).toBe(1);
  });

  it('approval debits the wallet first, refunds the card through the provider, and records the split; a provider that cannot refund leaves a manual payout', async () => {
    const ws = await cancelledWorkspace(1040, 20_000);
    const req = await json(await (await apiFor(ws)).call('POST', '/wallet/refund-requests', { amountMinor: 15_000 }));
    configurePayments(() => provider(true));
    const done = await json(await operatorCall(OP1, 'POST', `/refund-requests/${req.id}/decision`, { decision: 'approve', note: 'identity checked' }));
    expect(done).toMatchObject({ state: 'paid', cardRefundedMinor: 15_000, manualMinor: 0, decidedBy: OP1 });
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor, r.ref])).toEqual([['topup', 20_000, 'kashier:TX-1040'], ['refund', -15_000, `refund:${req.id}:1`]]);
    expect(await env.DB.prepare("SELECT refunded_minor FROM topups WHERE order_id = 'o-1040'").first()).toEqual({ refunded_minor: 15_000 });
    expect((await operatorCall(OP2, 'POST', `/refund-requests/${req.id}/decision`, { decision: 'approve' })).status).toBe(409); // never twice

    const ws2 = await cancelledWorkspace(1041, 20_000);
    const req2 = await json(await (await apiFor(ws2)).call('POST', '/wallet/refund-requests', { amountMinor: 8_000 }));
    configurePayments(() => provider(false));
    const manual = await json(await operatorCall(OP1, 'POST', `/refund-requests/${req2.id}/decision`, { decision: 'approve' }));
    expect(manual).toMatchObject({ state: 'manual_payout', cardRefundedMinor: 0, manualMinor: 8_000 });
    expect((await workspace(ws2).walletView()).balanceMinor).toBe(12_000); // debited either way: the money is owed by exactly one path
    expect((await operatorCall(OP1, 'POST', `/refund-requests/${req2.id}/manual-paid`)).status).toBe(200);
    expect((await json(await operatorCall(OP1, 'GET', '/refund-requests?state=paid'))).items!.some((r) => r.id === req2.id)).toBe(true);
  });

  it('a refund above the card top-ups goes to a manual payout for the rest; a rejection changes nothing; money moved since the request blocks approval', async () => {
    const ws = await cancelledWorkspace(1050, 10_000);
    await fund(ws, 6_000, 'adj:extra'); // 6,000 more in the wallet that no card top-up paid for
    const req = await json(await (await apiFor(ws)).call('POST', '/wallet/refund-requests', { amountMinor: 16_000 }));
    configurePayments(() => provider(true));
    expect(await json(await operatorCall(OP1, 'POST', `/refund-requests/${req.id}/decision`, { decision: 'approve' }))).toMatchObject({ state: 'manual_payout', cardRefundedMinor: 10_000, manualMinor: 6_000 });
    const ws2 = await cancelledWorkspace(1051, 10_000);
    const r2 = await json(await (await apiFor(ws2)).call('POST', '/wallet/refund-requests', { amountMinor: 9_000 }));
    expect((await operatorCall(OP1, 'POST', `/refund-requests/${r2.id}/decision`, { decision: 'reject', note: 'dispute open' })).status).toBe(200);
    expect(await ledger(ws2)).toHaveLength(1);
    const ws3 = await cancelledWorkspace(1052, 10_000);
    const r3 = await json(await (await apiFor(ws3)).call('POST', '/wallet/refund-requests', { amountMinor: 9_000 }));
    await workspace(ws3).postWallet({ kind: 'chargeback', netMinor: -5_000, ref: 'cb:1052' });
    expect((await operatorCall(OP1, 'POST', `/refund-requests/${r3.id}/decision`, { decision: 'approve' })).status).toBe(409);
    expect((await ledger(ws3)).map((r) => r.kind)).toEqual(['topup', 'chargeback']);
  });
});

describe('shared-number true-up', () => {
  it('only for a closed month with reported usage, once per number, immutable', async () => {
    expect((await operatorCall(OP1, 'POST', '/trueups', { month: '2999-01', phoneNumberId: 'pn-s', actualMinor: 0 })).status).toBe(409);
    expect(await (await operatorCall(OP1, 'POST', '/trueups', { month: '2020-01', phoneNumberId: 'pn-s', actualMinor: 0 })).json()).toMatchObject({ message: 'no_usage_reported' });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO shared_number_usage (month, phone_number_id, workspace_id, charged_minor, service_count, reported_at) VALUES ('2020-01', 'pn-s', 'a', 150, 3, 1)"),
      env.DB.prepare("INSERT INTO shared_number_usage (month, phone_number_id, workspace_id, charged_minor, service_count, reported_at) VALUES ('2020-01', 'pn-s', 'b', 50, 1, 1)"),
    ]);
    const ok = await operatorCall(OP1, 'POST', '/trueups', { month: '2020-01', phoneNumberId: 'pn-s', actualMinor: 80 });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ month: '2020-01', phoneNumberId: 'pn-s', actualMinor: 80, totalChargedMinor: 200, totalCount: 4, rebateMinor: 120 });
    expect(await (await operatorCall(OP2, 'POST', '/trueups', { month: '2020-01', phoneNumberId: 'pn-s', actualMinor: 10 })).json()).toMatchObject({ message: 'already_published' });
  });
});

describe('adjustments: the threshold is cumulative per actor (no splitting)', () => {
  const OPX = '33333333-3333-4333-8333-333333333333';
  const OPY = '44444444-4444-4444-8444-444444444444';
  it('10 x half the threshold by one operator: the first two self-approve, the third crosses the 24 h total and waits for someone else', async () => {
    const ws = W(1060);
    await seedNumber('pn-op1060', ws);
    const half = 50_000; // the default threshold is 100,000
    const out: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await json(await operatorCall(OPX, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: i % 2 ? -half : half, reason: `split ${i} of a big one` }));
      out.push(r.state as string);
      ids.push(r.id as string);
    }
    expect(out).toEqual(['approved', 'approved', ...Array(8).fill('pending')]); // signs do not cancel out: absolute values add up
    expect((await ledger(ws)).length).toBe(2);
    expect((await operatorCall(OPX, 'POST', `/adjustments/${ids[2]}/decision`, { decision: 'approve' })).status).toBe(403); // not their own
    expect((await operatorCall(OPY, 'POST', `/adjustments/${ids[2]}/decision`, { decision: 'approve' })).status).toBe(200);
    expect((await ledger(ws)).length).toBe(3);
    // a pending one approved by someone else is NOT the requester's self-approved total
    const next = await json(await operatorCall(OPY, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: 10, reason: 'tiny one by another operator' }));
    expect(next.state).toBe('approved');
  });

  it('8 parallel requests, each under the threshold: the self-approved total never passes it (atomic), the rest wait', async () => {
    const ws = W(1063);
    await seedNumber('pn-op1063', ws);
    const OPV = '77777777-7777-4777-8777-777777777777';
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => operatorCall(OPV, 'POST', `/workspaces/${ws}/adjustments`, { amountMinor: i % 2 ? -40_000 : 40_000, reason: `parallel ${i} just under` }).then(json)));
    const approved = results.filter((r) => r.state === 'approved');
    expect(approved).toHaveLength(2); // 40k + 40k = 80k; a third would make 120k > 100k
    expect(results.filter((r) => r.state === 'pending')).toHaveLength(6);
    const total = (await ledger(ws)).reduce((n, r) => n + Math.abs(r.amount_minor), 0);
    expect(total).toBeLessThanOrEqual(100_000);
    expect((await ledger(ws)).length).toBe(2);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM wallet_adjustments WHERE requested_by = ? AND state = 'pending'").bind(OPV).first<{ n: number }>())!.n).toBe(6);
  });

  it('the total spans workspaces, and a day-count cap stops many small ones', async () => {
    const a = W(1061);
    const b = W(1062);
    await seedNumber('pn-op1061', a);
    await seedNumber('pn-op1062', b);
    const OPZ = '55555555-5555-4555-8555-555555555555';
    expect((await json(await operatorCall(OPZ, 'POST', `/workspaces/${a}/adjustments`, { amountMinor: 60_000, reason: 'first half' }))).state).toBe('approved');
    expect((await json(await operatorCall(OPZ, 'POST', `/workspaces/${b}/adjustments`, { amountMinor: 60_000, reason: 'second half elsewhere' }))).state).toBe('pending');
    const OPW = '66666666-6666-4666-8666-666666666666';
    const states: string[] = [];
    for (let i = 0; i < 22; i++) states.push((await json(await operatorCall(OPW, 'POST', `/workspaces/${a}/adjustments`, { amountMinor: 1, reason: `one piaster ${i}` }))).state as string);
    expect(states.filter((x) => x === 'approved')).toHaveLength(20);
    expect(states.slice(20)).toEqual(['pending', 'pending']);
  });
});

describe('state-changing operator routes check the session (fail closed)', () => {
  const writes: [string, string, unknown][] = [
    ['POST', '/pricing-settings', { marginBps: 0, creditLimitMinor: 5000, fxBufferBps: 0, vatBps: 0, reason: 'session check' }],
    ['POST', `/pricing-overrides/${W(1070)}`, { marginBps: 0, reason: 'session check' }],
    ['POST', '/rate-cards', { effectiveFrom: Date.now() + 30 * HOUR, rates: [{ country: 'EG', category: 'marketing', usdMicros: 1 }], reason: 'session check' }],
    ['POST', '/fx-rates', { effectiveFrom: Date.now() + 30 * HOUR, egpPerUsdMicros: 50_000_000, reason: 'session check' }],
    ['PUT', '/numbers/pn-x/funding', { funding: 'merchant_card', reason: 'session check' }],
    ['POST', `/workspaces/${W(1070)}/adjustments`, { amountMinor: 5, reason: 'session check' }],
    ['POST', '/adjustments/x/decision', { decision: 'approve' }],
    ['POST', '/refund-requests/x/decision', { decision: 'approve' }],
    ['POST', '/refund-requests/x/manual-paid', undefined],
    ['POST', '/trueups', { month: '2020-01', phoneNumberId: 'p', actualMinor: 0 }],
    ['PUT', `/workspaces/${W(1070)}/subscription`, { packageId: 'p', status: 'active', periodEnd: 9_999_999_999_999, reason: 'session check' }],
  ];
  it.each(writes)('%s %s: a revoked session is refused (403), nothing is written', async (method, path, body) => {
    configureSessionCheck(async () => true);
    const before = await env.DB.prepare('SELECT count(*) AS n FROM billing_audit').first<{ n: number }>();
    expect((await operatorCall(OP1, method, path, body)).status).toBe(403);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM billing_audit').first<{ n: number }>()).toEqual(before);
  });
  it.each(writes)('%s %s: an accounts service that errors or is missing refuses (503)', async (method, path, body) => {
    configureSessionCheck(async () => { throw new Error('accounts down'); });
    expect((await operatorCall(OP1, method, path, body)).status).toBe(503);
    configureSessionCheck(null); // no override and no ACCOUNTS binding in this environment
    expect((await operatorCall(OP1, method, path, body)).status).toBe(503);
  });
  it('only the listed global-configuration reads skip the check (test/operator-session.test.ts walks all routes); a healthy session passes the check', async () => {
    configureSessionCheck(null);
    expect((await operatorCall(OP1, 'GET', '/pricing-settings')).status).toBe(200); // listed: no personal data
    expect((await operatorCall(OP1, 'GET', '/change-log')).status).toBe(503); // everything else fails closed without a working session check
    configureSessionCheck(async () => false);
    expect((await operatorCall(OP1, 'PUT', '/numbers/pn-nobody/funding', { funding: 'merchant_card', reason: 'session check' })).status).toBe(404); // past the check, then the normal answer
  });
});

describe('GET /operator/me (store-independent super-admin check)', () => {
  it('a super admin with no stores gets 200; no token 401; a store owner 403', async () => {
    const ok = await operatorCall(OP1, 'GET', '/me');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ superAdmin: true, userId: OP1 });
    expect((await operatorCall(null, 'GET', '/me')).status).toBe(401);
    const owner = await apiFor(W(1001));
    const { SELF } = await import('cloudflare:test');
    expect((await SELF.fetch('https://x/api/v1/operator/me', { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(403);
  });
});
