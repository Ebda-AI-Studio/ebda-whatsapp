import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { configurePayments } from '../src/core/billing/payments';
import { configureSessionCheck } from '../src/core/identity/session';
import { storeId as W0, apiFor, useApiKey } from './helpers/api';
import { testKashier } from './helpers/kashier';
import { useStoreLink } from './helpers/store-link';

// Ruling WA-INSTAPAY-LAUNCH-1: TOPUPS_ENABLED and PACKAGE_CHECKOUT_ENABLED are ON in production while Kashier is NOT configured. The merchant pays by InstaPay
// (create the request, transfer, upload the receipt); every card route fails closed (503) and the wallet says so, so the screen never offers a dead card button.
useApiKey();
useStoreLink();
const W = (n: number) => W0(9800 + n);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
beforeEach(async () => {
  configureSessionCheck(async () => false);
  configurePayments(() => null); // no Kashier merchant id / api key
  await env.DB.prepare("INSERT OR IGNORE INTO packages (id, name, price_minor, ai_credits, active, created_at) VALUES ('gold', 'Gold', 50000, 300, 1, 1)").run();
});
afterEach(() => { configureSessionCheck(null); vi.restoreAllMocks(); });

it('with both switches on and no card provider: the package list is open, the wallet says card checkout is off, card top-up and card package checkout answer 503', async () => {
  const owner = await apiFor(W(1));
  const list = await owner.call('GET', '/packages');
  expect(list.status).toBe(200);
  expect(((await list.json()) as { items: { id: string }[] }).items.map((p) => p.id)).toContain('gold');
  const wallet = (await (await owner.call('GET', '/wallet')).json()) as { topupsEnabled: boolean; cardCheckout: boolean };
  expect(wallet).toMatchObject({ topupsEnabled: true, cardCheckout: false });
  expect((await owner.call('POST', '/wallet/topups', { amountMinor: 20000 })).status).toBe(503);
  expect((await owner.call('POST', '/packages/gold/checkout')).status).toBe(503);
  expect((await env.DB.prepare('SELECT count(*) AS n FROM topups WHERE workspace_id = ?').bind(W(1)).first<{ n: number }>())!.n).toBe(0); // nothing written by the refused card paths
  expect((await env.DB.prepare('SELECT count(*) AS n FROM package_orders WHERE workspace_id = ?').bind(W(1)).first<{ n: number }>())!.n).toBe(0);
});

it('the wallet reports card checkout ready only when the provider can confirm its webhooks', async () => {
  configurePayments(() => testKashier());
  const owner = await apiFor(W(2));
  expect(((await (await owner.call('GET', '/wallet')).json()) as { cardCheckout: boolean }).cardCheckout).toBe(true);
});

it('InstaPay end to end up to the receipt: a package, then a top-up, each created, paid to the payee, proof uploaded, parked for review (not granted)', async () => {
  const owner = await apiFor(W(3));
  for (const body of [{ kind: 'package', packageId: 'gold' }, { kind: 'topup', amountMinor: 20000 }] as const) {
    const made = await owner.call('POST', '/wallet/instapay', body);
    expect(made.status).toBe(201);
    const req = (await made.json()) as { id: string; state: string; reference: string; amountMinor: number; payee: { handle: string } };
    expect(req).toMatchObject({ state: 'awaiting_proof', amountMinor: body.kind === 'package' ? 50000 : 20000, payee: { handle: 'ebda@instapay' } });
    const up = await SELF.fetch(`https://x/api/v1/stores/${W(3)}/wallet/instapay/${req.id}/proof`, { method: 'PUT', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'image/png' }, body: new Uint8Array([...PNG, ...crypto.getRandomValues(new Uint8Array(4))]) });
    expect(up.status).toBe(200);
    expect(await up.json()).toMatchObject({ id: req.id, state: 'under_review', hasProof: true });
  }
  const mine = (await (await owner.call('GET', '/wallet/instapay')).json()) as { items: { state: string }[] };
  expect(mine.items.map((i) => i.state)).toEqual(['under_review', 'under_review']);
  expect(await env.DB.prepare('SELECT package_id FROM workspace_subscriptions WHERE workspace_id = ?').bind(W(3)).first()).toBeNull(); // review, not grant, until an operator confirms
});
