import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { DAY, chat, fund, jobOf, ledger, nowS, pricing, queueTemplate, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000074${String(n).padStart(2, '0')}`;
const T1 = Date.now() + 10 * DAY;
const T2 = Date.now() + 20 * DAY;

async function publish(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at) VALUES (2, ?, 1000, 7000, 0, 1400, 'op-1', 'launch margin', 0)").bind(T1),
    env.DB.prepare("INSERT OR IGNORE INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at) VALUES (3, ?, 2000, 7000, 0, 1400, 'op-1', 'raise', 0)").bind(T2),
  ]);
}

async function deliver(ws: string, conv: number, n: string, at: number) {
  const j = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
  await sendOut(ws, j, wamidOf(n));
  await status(ws, wamidOf(n), 'sent', nowS(), pricing('marketing'));
  await status(ws, wamidOf(n), 'delivered', Math.floor(at / 1000));
}

describe('WA-MARGIN-1: effective-dated, never retroactive', () => {
  it('a delivery is priced by the settings version in effect when it was delivered', async () => {
    await publish();
    const ws = W(1);
    await setupBilling(ws);
    await fund(ws, 10_000);
    const conv = await chat(ws);
    await deliver(ws, conv, 'a', Date.now());
    await deliver(ws, conv, 'b', T1 + 1000);
    await deliver(ws, conv, 'c', T2 + 1000);
    const charges = (await ledger(ws)).filter((r) => r.kind === 'meta_charge');
    // 250 at 0%; 250 x 1.10 = 275 + 14% VAT (38.5 -> 38, half-even); 250 x 1.20 = 300 + 42
    expect(charges.map((c) => [c.net_minor, c.vat_minor, c.amount_minor])).toEqual([[-250, 0, -250], [-275, -38, -313], [-300, -42, -342]]);
    // earlier rows are untouched by later settings (the ledger is append-only and nothing recomputes)
    expect((await ledger(ws))[1]!.amount_minor).toBe(-250);
  });

  it('a per-workspace override replaces the margin only, from its own date, and says so on the row', async () => {
    await publish();
    const a = W(2);
    const b = W(3);
    await setupBilling(a);
    await setupBilling(b);
    await env.DB.prepare("INSERT INTO workspace_pricing_overrides (workspace_id, ver, effective_from, margin_bps, actor, reason, created_at) VALUES (?, 1, 0, 500, 'op-1', 'launch deal', 0)").bind(b).run();
    await workspace(b).refreshPricing();
    for (const ws of [a, b]) await fund(ws, 10_000);
    const [ca, cb] = [await chat(a), await chat(b)];
    await deliver(a, ca, 'oa', Date.now());
    await deliver(b, cb, 'ob', Date.now());
    expect((await ledger(a)).at(-1)).toMatchObject({ amount_minor: -250 });
    expect((await ledger(b)).at(-1)).toMatchObject({ amount_minor: -262 }); // 250 x 1.05 = 262.5 -> 262 (even)
    expect((await rows<{ note: string | null }>(b, "SELECT note FROM wallet_ledger WHERE kind = 'meta_charge'"))[0]!.note).toBe('override:1');
    // the override is B's alone
    expect((await rows<{ n: number }>(a, 'SELECT count(*) AS n FROM pricing_overrides'))[0]!.n).toBe(0);
  });

  it('the overdraft limit is a versioned setting too: the claim uses the one in effect now', async () => {
    await publish();
    const ws = W(4);
    await setupBilling(ws);
    await workspace(ws).postWallet({ kind: 'chargeback', netMinor: -4950, ref: 'cb:limit' });
    const conv = await chat(ws);
    const j = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(j, Date.now())).toBe('deferred'); // 100 more than the 50 EGP limit
    expect(await workspace(ws).claimSend(j, T1 + 1000)).toBe('claimed'); // after the limit rose to 70 EGP
  });

  it('only new versions are pulled; a version the workspace already has is never rewritten', async () => {
    await publish();
    const ws = W(5);
    await setupBilling(ws);
    const before = await rows(ws, 'SELECT * FROM pricing_settings ORDER BY src_id');
    await workspace(ws).refreshPricing();
    expect(await rows(ws, 'SELECT * FROM pricing_settings ORDER BY src_id')).toEqual(before);
    expect(before.length).toBeGreaterThanOrEqual(3);
  });

  it('rate cards, FX and settings versions in D1 cannot be edited or deleted', async () => {
    await publish();
    await expect(env.DB.prepare('UPDATE pricing_settings SET margin_bps = 0').run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare('DELETE FROM rate_cards').run()).rejects.toThrow(/immutable/);
    await expect(env.DB.prepare('UPDATE fx_rates SET egp_per_usd_micros = 1').run()).rejects.toThrow(/immutable/);
    await env.DB.prepare("INSERT INTO billing_audit (at, actor, action) VALUES (1, 'op-1', 'test')").run();
    await expect(env.DB.prepare('UPDATE billing_audit SET actor = 1').run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM billing_audit').run()).rejects.toThrow(/append-only/);
  });
});
