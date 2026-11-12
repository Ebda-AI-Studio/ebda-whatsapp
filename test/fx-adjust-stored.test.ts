import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chat, fund, jobOf, ledger, nowS, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000075${String(n).padStart(2, '0')}`;

describe('FX review: a category change is adjusted from what was CHARGED, never from a re-price', () => {
  it('a newer FX version with an old effective date does not distort the adjustment (charged 100, Meta bills marketing at the new rate)', async () => {
    const ws = W(1);
    await setupBilling(ws); // fx v1: 50 EGP per USD -> utility 100, marketing 250 piasters
    await fund(ws, 5000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await sendOut(ws, job, wamidOf('adj1'));
    await status(ws, wamidOf('adj1'), 'delivered', nowS(), pricing('utility'));
    expect((await ledger(ws)).map((r) => r.amount_minor)).toEqual([5000, -100]);
    // A later version dated at the same instant wins fxAt (ver DESC): a re-price of the old category would now read 200, not the 100 actually charged.
    await env.DB.prepare("INSERT INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor) VALUES (2, 0, 100000000, 0, 0, 'test')").run();
    await workspace(ws).refreshPricing();
    await status(ws, wamidOf('adj1'), 'read', nowS() + 1, pricing('marketing'));
    const adj = (await ledger(ws)).find((r) => r.kind === 'meta_adjust')!;
    expect(adj.amount_minor).toBe(-(500 - 100)); // new marketing price (500) minus the 100 that was charged
  });
});
