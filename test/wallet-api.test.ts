import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { costEstimateDto, statementDto, walletDto } from '../src/core/api/contract';
import { monthOf } from '../src/core/billing/trueup';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { chat, fund, jobOf, nowS, pn, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { rows, workspace } from './helpers/workspace';

useApiKey();

describe('GET /wallet', () => {
  it('shows balance, held, available, debt, the overdraft, funding per number, switches and the plan, in the contract shape', async () => {
    const ws = W(1100);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws, { funding: 'platform_line' });
    await fund(ws, 10_000);
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'pro', status: 'active', periodStart: Date.now() - 1000, periodEnd: Date.now() + 86_400_000 * 20, aiCredits: 40 });
    const conv = await chat(ws);
    await queueTemplate(ws, conv, 'MARKETING'); // holds 250
    const r = await api.call('GET', '/wallet');
    expect(r.status).toBe(200);
    const w = walletDto.parse(await r.json());
    expect(w).toMatchObject({
      balanceMinor: 10_000, heldMinor: 250, availableMinor: 9_750, debtMinor: 0, creditLimitMinor: 5_000, currency: 'EGP', topupsEnabled: true, lowBalance: false,
      funding: [{ phoneNumberId: pn(ws), funding: 'platform_line' }], aiCredits: { balance: 40, available: 40 }, plan: { packageId: 'pro', status: 'active' },
    });
    const staff = await (await apiFor(ws, 'staff')).call('GET', '/wallet');
    expect(staff.status).toBe(200); // everyone in the store may look
  });

  it('a merchant-card number is reported as such (the UI shows "Meta bills your card")', async () => {
    const ws = W(1101);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws, { funding: 'merchant_card' });
    expect(walletDto.parse(await (await api.call('GET', '/wallet')).json()).funding).toEqual([{ phoneNumberId: pn(ws), displayPhone: null, funding: 'merchant_card' }]);
  });

  it('a number with no funding row is reported unknown, never as a card payer (the server refuses sends for it)', async () => {
    const ws = W(1103);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws, { funding: null });
    await env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(pn(ws)).run(); // seedNumber adds a card row; this number has none
    expect(walletDto.parse(await (await api.call('GET', '/wallet')).json()).funding).toEqual([{ phoneNumberId: pn(ws), displayPhone: null, funding: 'unknown' }]);
  });

  it('debt and the low-balance flag: a chargeback below zero is debt; one alert a day, not one per row', async () => {
    const spy = vi.spyOn(console, 'error');
    const ws = W(1102);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws);
    await fund(ws, 1500);
    await workspace(ws).postWallet({ kind: 'chargeback', netMinor: -2000, ref: 'cb:1102' });
    await workspace(ws).postWallet({ kind: 'chargeback', netMinor: -100, ref: 'cb:1102b' });
    const w = walletDto.parse(await (await api.call('GET', '/wallet')).json());
    expect(w).toMatchObject({ balanceMinor: -600, debtMinor: 600, lowBalance: true, availableMinor: -600 });
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('wallet_low_balance') && String(c[0]).includes(ws))).toHaveLength(1);
  });
});

describe('GET /wallet/statement', () => {
  async function activeMonth(n: number) {
    const ws = W(n);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws);
    await fund(ws, 5_000, 'kashier:s1');
    const conv = await chat(ws);
    for (const [i, cat] of (['MARKETING', 'UTILITY'] as const).entries()) {
      const j = jobOf(await queueTemplate(ws, conv, cat));
      await sendOut(ws, j, wamidOf(`st${i}`));
      await status(ws, wamidOf(`st${i}`), 'delivered', nowS(), pricing(cat.toLowerCase()));
    }
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -50, ref: 'adj:s', actor: 'op', note: '=cmd|evil' });
    return { ws, api, month: monthOf(Date.now()) };
  }

  it('stored rows with opening and closing balances, totals per kind and per category, in the contract shape', async () => {
    const { api, month } = await activeMonth(1110);
    const st = statementDto.parse(await (await api.call('GET', `/wallet/statement?month=${month}`)).json());
    expect(st).toMatchObject({ month, openingMinor: 0, closingMinor: 5_000 - 250 - 100 - 50, truncated: false });
    expect(st.rows.map((r) => [r.kind, r.amountMinor, r.balanceAfterMinor])).toEqual([['topup', 5000, 5000], ['meta_charge', -250, 4750], ['meta_charge', -100, 4650], ['adjustment', -50, 4600]]);
    expect(st.totalsByKind.meta_charge).toEqual({ count: 2, netMinor: -350, vatMinor: 0, amountMinor: -350 });
    expect(st.totalsByCategory).toEqual({ marketing: { count: 1, netMinor: -250, vatMinor: 0, amountMinor: -250 }, utility: { count: 1, netMinor: -100, vatMinor: 0, amountMinor: -100 } });
    // another month is empty but keeps the balance it opened with
    const next = month === '2999-12' ? '2999-11' : '2099-01';
    const other = statementDto.parse(await (await api.call('GET', `/wallet/statement?month=${next}`)).json());
    expect(other.rows).toEqual([]);
  });

  it('CSV: one line per stored row plus opening and closing, amounts as exact EGP, spreadsheet formulas defused', async () => {
    const { api, month } = await activeMonth(1112);
    const r = await api.call('GET', `/wallet/statement?month=${month}&format=csv`);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain(`statement-${month}.csv`);
    const lines = (await r.text()).trim().split('\n');
    expect(lines[0]).toBe('date_utc,kind,category,net_egp,vat_egp,amount_egp,balance_after_egp,ref,wamid,note');
    expect(lines[1]).toContain('opening_balance');
    expect(lines.some((l) => l.includes('meta_charge') && l.includes('-2.50') && l.includes('marketing'))).toBe(true);
    expect(lines.some((l) => l.includes("'=cmd|evil"))).toBe(true);
    expect(lines.at(-1)).toContain('closing_balance,,,,,46.00');
  });

  it('is the owner\'s: staff 403, a bad month 400, and a month is read from stored rows only', async () => {
    const { ws, month } = await activeMonth(1113);
    expect((await (await apiFor(ws, 'staff')).call('GET', `/wallet/statement?month=${month}`)).status).toBe(403);
    const api = await apiFor(ws, 'owner');
    expect((await api.call('GET', '/wallet/statement?month=2026-13')).status).toBe(400);
    expect((await api.call('GET', '/wallet/statement')).status).toBe(400);
    // later price changes never rewrite history
    await env.DB.prepare("INSERT OR IGNORE INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at) VALUES (9, ?, 5000, 5000, 0, 1400, 'op', 'later change', 0)").bind(Date.now() + 5 * 86_400_000).run();
    await workspace(ws).refreshPricing();
    const st = statementDto.parse(await (await api.call('GET', `/wallet/statement?month=${month}`)).json());
    expect(st.rows.filter((r) => r.kind === 'meta_charge').map((r) => r.amountMinor)).toEqual([-250, -100]);
  });

  it('VAT is carried per row and summed from stored values', async () => {
    const ws = W(1111);
    const api = await apiFor(ws, 'owner', pn(ws));
    await setupBilling(ws);
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -100, vatMinor: -14, ref: 'adj:vat', actor: 'op', note: 'vat row' });
    const st = statementDto.parse(await (await api.call('GET', `/wallet/statement?month=${monthOf(Date.now())}`)).json());
    expect(st.totalsByKind.adjustment).toEqual({ count: 1, netMinor: -100, vatMinor: -14, amountMinor: -114 });
    expect((await rows(ws, 'SELECT net_minor, vat_minor, amount_minor FROM wallet_ledger'))[0]).toEqual({ net_minor: -100, vat_minor: -14, amount_minor: -114 });
  });
});

describe('GET /wallet/estimate', () => {
  it('prices a send before it is made: the wallet pays for a platform number, nothing for a merchant-card number', async () => {
    const a = W(1120);
    const apiA = await apiFor(a, 'owner', pn(a));
    await setupBilling(a, { funding: 'platform_line' });
    const r = costEstimateDto.parse(await (await apiA.call('GET', '/wallet/estimate?category=marketing&count=40')).json());
    expect(r).toEqual({ funding: 'platform_line', paidBy: 'wallet', perMessageMinor: 250, totalMinor: 10_000, priced: true, currency: 'EGP' });
    expect(costEstimateDto.parse(await (await apiA.call('GET', '/wallet/estimate?category=utility&country=EG')).json())).toMatchObject({ perMessageMinor: 100, totalMinor: 100 });
    const b = W(1121);
    const apiB = await apiFor(b, 'owner', pn(b));
    await setupBilling(b, { funding: 'merchant_card' });
    expect(costEstimateDto.parse(await (await apiB.call('GET', '/wallet/estimate?category=marketing&count=40')).json())).toMatchObject({ funding: 'merchant_card', paidBy: 'merchant_card', perMessageMinor: 0, totalMinor: 0 });
    expect((await apiA.call('GET', '/wallet/estimate?category=bogus')).status).toBe(400);
  });
});
