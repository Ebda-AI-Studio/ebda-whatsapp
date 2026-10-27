import { env } from 'cloudflare:test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { KashierProvider, configurePayments } from '../src/core/billing/payments';
import { handleProviderWebhook } from '../src/core/billing/topups';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, useApiKey } from './helpers/api';
import { fund, ledger } from './helpers/billing';
import { kashierLedger, testKashier } from './helpers/kashier';
import { signedWebhook } from './helpers/kashier-webhook';
import { seedNumber } from './helpers/workspace';

useApiKey();
const W = (n: number) => W0(9700 + n);
const all = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<T>().then((r) => r.results);

describe('indexes on the hot workspace_id lookups (M-057)', () => {
  // The queries as the code issues them (phone_numbers: numbers of a store; refund_requests: a store's requests; billing_audit: the change log of one store; the rest are regression pins).
  const HOT: [string, string][] = [
    ['phone_numbers by workspace', "SELECT phone_number_id FROM phone_numbers WHERE workspace_id = 'x' AND status = 'active'"],
    ['refund_requests open for a workspace', "SELECT id FROM refund_requests WHERE workspace_id = 'x' AND state IN ('pending', 'processing')"],
    ['refund_requests listing', "SELECT id FROM refund_requests WHERE workspace_id = 'x' ORDER BY created_at DESC LIMIT 200"],
    ['billing_audit for a workspace', "SELECT id FROM billing_audit WHERE workspace_id = 'x' ORDER BY id DESC LIMIT 50"],
    ['topups by workspace', "SELECT order_id FROM topups WHERE workspace_id = 'x' ORDER BY created_at DESC"],
    ['package_orders by workspace', "SELECT order_id FROM package_orders WHERE workspace_id = 'x' AND queued_seq IS NOT NULL"],
    ['instapay_requests by workspace', "SELECT id FROM instapay_requests WHERE workspace_id = 'x' AND state IN ('awaiting_proof', 'under_review')"],
    ['shared_routes by workspace', "SELECT customer_key FROM shared_routes WHERE workspace_id = 'x'"],
    ['waba_credentials by workspace', "SELECT waba_id FROM waba_credentials WHERE workspace_id = 'x'"],
    ['operator_actions by workspace', "SELECT id FROM operator_actions WHERE workspace_id = 'x' ORDER BY id DESC LIMIT 20"],
    ['ledger_mirror by workspace', "SELECT ref FROM ledger_mirror WHERE workspace_id = 'x' AND ledger = 'wallet'"],
  ];
  it.each(HOT)('%s is a SEARCH on an index, never a table SCAN', async (_name, sql) => {
    const plan = (await all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)).map((r) => r.detail).join(' | ');
    expect(plan).not.toMatch(/\bSCAN\b/);
    expect(plan).toMatch(/SEARCH/);
  });

  // Tables addressed another way (and why). A new table with a workspace_id column has to join an index or this list.
  const OTHER_KEY: Record<string, string> = {
    workspaces: 'the id IS the workspace id',
    wallet_adjustments: 'the operator queue is read by state or id, never filtered by workspace',
    card_refunds: 'read by order, request or provider refund id',
    package_refund_plans: 'keyed by the order id',
    shared_number_usage: 'read by month and platform number first',
    shared_number_sends: 'read by platform number and bucket first',
    shared_number_errors: 'read by platform number and bucket first',
    shared_number_strikes: 'read by platform number and workspace (its index leads with the number)',
  };
  it('every table with a workspace_id column has an index that LEADS with it, or is listed with the key it is read by', async () => {
    const tables = await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\' AND name NOT LIKE 'd1_%'");
    const missing: string[] = [];
    for (const { name } of tables) {
      const cols = await all<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`);
      if (!cols.some((c) => c.name === 'workspace_id') || name in OTHER_KEY) continue;
      const idx = await all<{ name: string }>(`SELECT name FROM pragma_index_list('${name}')`);
      let leads = false;
      for (const i of idx) leads ||= (await all<{ name: string }>(`SELECT name FROM pragma_index_info('${i.name}') WHERE seqno = 0`))[0]?.name === 'workspace_id';
      if (!leads) missing.push(name);
    }
    expect(missing, 'tables whose workspace_id lookups would scan (add an index in migrations/d1, or list them above with the key they are read by)').toEqual([]);
    for (const [t, why] of Object.entries(OTHER_KEY)) expect(why.length, t).toBeGreaterThan(10);
  });
});

describe('refunded can never exceed charged (M-138)', () => {
  it('the database refuses it: topups and package_orders, on insert and on update', async () => {
    const ws = W(1);
    await seedNumber(`pn-d1-${ws.slice(-6)}`, ws);
    await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('d1p', 'D1', 1000, 0, 1, 1)").run();
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at, refunded_minor) VALUES ('d1-t1', ?, 1000, 1000, 'paid', 'u', 1, 1000)").bind(ws).run(); // equal is fine
    await expect(env.DB.prepare('UPDATE topups SET refunded_minor = 1001 WHERE order_id = ?').bind('d1-t1').run()).rejects.toThrow(/refunded exceeds charged/);
    await expect(env.DB.prepare('UPDATE topups SET amount_minor = 999 WHERE order_id = ?').bind('d1-t1').run()).rejects.toThrow(/refunded exceeds charged/);
    await expect(env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, total_minor, state, created_by, created_at, refunded_minor) VALUES ('d1-t2', ?, 1000, 1000, 'paid', 'u', 1, 1001)").bind(ws).run()).rejects.toThrow(/refunded exceeds charged/);
    await env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, status, created_by, created_at, refunded_minor) VALUES ('d1-p1', ?, 'd1p', 1000, 'paid', 'u', 1, 1000)").bind(ws).run();
    await expect(env.DB.prepare('UPDATE package_orders SET refunded_minor = refunded_minor + 1 WHERE order_id = ?').bind('d1-p1').run()).rejects.toThrow(/refunded exceeds charged/);
    await expect(env.DB.prepare("INSERT INTO package_orders (order_id, workspace_id, package_id, amount_minor, status, created_by, created_at, refunded_minor) VALUES ('d1-p2', ?, 'd1p', 1000, 'paid', 'u', 1, 1001)").bind(ws).run()).rejects.toThrow(/refunded exceeds charged/);
  });
});

describe('the code never tries: a provider refund past what is left is clamped, the wallet is still debited in full, and nothing throws', () => {
  const kashier = testKashier();
  beforeEach(() => { configureSessionCheck(async () => false); configurePayments(() => kashier); });
  afterEach(() => { configureSessionCheck(null); configurePayments((e) => (e.KASHIER_MERCHANT_ID && e.KASHIER_API_KEY ? new KashierProvider(e.KASHIER_MERCHANT_ID, e.KASHIER_API_KEY) : null)); vi.restoreAllMocks(); });
  const hook = async (order: string, tx: string, egp: string) => { const { body, sig } = await signedWebhook({ merchantOrderId: order, transactionId: tx, amount: egp, status: 'SUCCESS' }, 'refund'); return handleProviderWebhook(env, body, sig, kashier); };

  it('two unknown provider refunds that together exceed the top-up: refunded_minor stops at the charged amount, both are debited, neither is lost', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = W(2);
    await seedNumber(`pn-d1-${ws.slice(-6)}`, ws);
    await env.DB.prepare("INSERT INTO topups (order_id, workspace_id, amount_minor, fee_minor, total_minor, currency, state, created_by, created_at, transaction_id, paid_at) VALUES ('d1-o2', ?, 20000, 0, 20000, 'EGP', 'paid', 'u', 1, 'TX-D1-2', 2)").bind(ws).run();
    kashierLedger.set('TX-D1-2', { operation: 'pay', status: 'SUCCESS', orderId: 'd1-o2' });
    await fund(ws, 20000, 'kashier:TX-D1-2');
    expect((await hook('d1-o2', 'P-D1-a', '150.00')).status).toBe(200);
    expect((await hook('d1-o2', 'P-D1-b', '100.00')).status).toBe(200); // 50 left on the top-up, 100 refunded by the provider
    expect((await all<{ refunded_minor: number }>("SELECT refunded_minor FROM topups WHERE order_id = 'd1-o2'"))[0]!.refunded_minor).toBe(20000); // clamped, not 25000
    expect((await ledger(ws)).map((r) => [r.kind, r.amount_minor])).toEqual([['topup', 20000], ['chargeback', -15000], ['chargeback', -10000]]); // the wallet still lost what the provider took back
    void spy;
  });
});
