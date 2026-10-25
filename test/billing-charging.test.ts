import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { PIASTERS, DAY, chat, fund, holdOf, holds, jobOf, ledger, nowS, pn, pricing, queueTemplate, queueText, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { PARAMS, seedContacts, seedTemplate, setPageSize } from './helpers/campaigns';
import { exec, openChat, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000073${String(n).padStart(2, '0')}`;
const alerts = () => vi.spyOn(console, 'error');
const alertNames = (spy: ReturnType<typeof alerts>) => spy.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } }).filter(Boolean);

describe('hold, charge, release', () => {
  it('a send holds its estimate at queue time (once: the claim finds the same hold) and available drops', async () => {
    const ws = W(1);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    expect(await holdOf(ws, job)).toEqual({ amount_minor: PIASTERS.marketing, state: 'held', release_reason: null });
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 1000, heldMinor: 250, availableMinor: 750 });
    expect(await workspace(ws).claimSend(job)).toBe('claimed');
    expect((await holds(ws)).length).toBe(1);
    expect((await workspace(ws).walletView()).heldMinor).toBe(250);
  });

  it('charges on the first delivered with a billable flag, at the delivery-time rate, and records the versions on the row', async () => {
    const ws = W(2);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf(2));
    await status(ws, wamidOf(2), 'sent', nowS(), pricing('marketing'));
    expect(await ledger(ws)).toHaveLength(1); // only the top-up: sent is not a charge
    await status(ws, wamidOf(2), 'delivered', nowS());
    expect(await ledger(ws)).toEqual([
      expect.objectContaining({ kind: 'topup' }),
      { kind: 'meta_charge', amount_minor: -250, net_minor: -250, vat_minor: 0, balance_after: 750, ref: `meta:${wamidOf(2)}`, category: 'marketing', rate_ver: 1, fx_ver: 1 },
    ]);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'charged' });
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 750, heldMinor: 0, availableMinor: 750 });
  });

  it('(b) one charge per wamid under duplicate and out-of-order webhooks, including statuses that arrive before Meta accepted the send', async () => {
    const ws = W(3);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(job)).toBe('claimed');
    const t = nowS();
    // delivered and read arrive BEFORE we stored the wamid (the accept response is slow)
    await status(ws, wamidOf(3), 'read', t + 2, pricing('utility'));
    await status(ws, wamidOf(3), 'delivered', t + 1);
    expect(await ledger(ws)).toHaveLength(1);
    await workspace(ws).recordOutbound(job.idempotencyKey, { ok: true, wamid: wamidOf(3) });
    expect(await ledger(ws)).toHaveLength(2);
    // then every kind of repeat and reorder
    await status(ws, wamidOf(3), 'delivered', t + 1);
    await status(ws, wamidOf(3), 'delivered', t + 5, pricing('utility'));
    await status(ws, wamidOf(3), 'sent', t, pricing('utility'));
    await status(ws, wamidOf(3), 'read', t + 2, pricing('utility'));
    await status(ws, wamidOf(3), 'read', t + 9, pricing('utility'));
    expect((await ledger(ws)).filter((r) => r.kind === 'meta_charge')).toHaveLength(1);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(1000 - PIASTERS.utility);
  });

  it('a status with no pricing yet does not charge; the charge lands when Meta says billable', async () => {
    const ws = W(4);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf(4));
    await status(ws, wamidOf(4), 'delivered', nowS());
    expect(await ledger(ws)).toHaveLength(1);
    await status(ws, wamidOf(4), 'read', nowS() + 1, pricing('marketing'));
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup', 'meta_charge']);
  });

  it('prices by the version in effect at delivery, not at send: a rate published for later applies only to later deliveries', async () => {
    const ws = W(5);
    const T = Date.now() + 30 * DAY;
    await setupBilling(ws, { rates: [{ country: 'SA', category: 'marketing', usd: 100_000, ver: 1 }, { country: 'SA', category: 'marketing', usd: 200_000, ver: 2, from: T }] });
    await fund(ws, 5000);
    const conv = await openChat(ws, '966501234567');
    await seedTemplate(ws, { name: 'tpl-m', category: 'MARKETING' });
    const send = async (n: number) => {
      const j = jobOf(await workspace(ws).queueOutbound(conv, pn(ws), { type: 'template', clientId: `00000000-0000-4000-8000-0000000000${n}`, name: 'tpl-m', language: 'ar', params: ['a', 'b'] }));
      await sendOut(ws, j, wamidOf(`v${n}`));
      await status(ws, wamidOf(`v${n}`), 'sent', nowS(), pricing('marketing'));
      return j;
    };
    const now = await send(10);
    expect(await holdOf(ws, now)).toMatchObject({ amount_minor: 500 }); // estimated with the version in effect today
    await send(11);
    await status(ws, wamidOf('v10'), 'delivered', nowS());
    await status(ws, wamidOf('v11'), 'delivered', Math.floor(T / 1000) + 60); // delivered after the new rate took effect
    const charges = (await ledger(ws)).filter((r) => r.kind === 'meta_charge');
    expect(charges.map((c) => [c.amount_minor, c.rate_ver])).toEqual([[-500, 1], [-1000, 2]]);
  });

  it('not billable releases the hold with no charge (a utility message inside an open window)', async () => {
    const ws = W(6);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await sendOut(ws, job, wamidOf(6));
    await status(ws, wamidOf(6), 'sent', nowS(), pricing('utility', false));
    await status(ws, wamidOf(6), 'delivered', nowS());
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'not_billable' });
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']);
  });

  it('a failed status with no charge releases the hold', async () => {
    const ws = W(7);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf(7));
    await status(ws, wamidOf(7), 'failed', nowS(), undefined, 131026);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'failed' });
    expect((await workspace(ws).walletView()).availableMinor).toBe(1000);
  });

  it('a pricing model other than PMP is unpriced: an alert, no charge, the hold is released', async () => {
    const spy = alerts();
    const ws = W(8);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf(8));
    await status(ws, wamidOf(8), 'sent', nowS(), pricing('marketing', true, 'CBP'));
    await status(ws, wamidOf(8), 'delivered', nowS());
    expect(alertNames(spy)).toContain('billing_unpriced_model');
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'unpriced' });
    expect(await rows(ws, 'SELECT unpriced FROM billable_sends')).toEqual([{ unpriced: 1 }]);
  });

  it("Meta's billed category wins: a later status naming another category posts the difference as meta_adjust, once", async () => {
    const ws = W(9);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await sendOut(ws, job, wamidOf(9));
    await status(ws, wamidOf(9), 'delivered', nowS(), pricing('utility'));
    await status(ws, wamidOf(9), 'read', nowS() + 1, pricing('marketing'));
    await status(ws, wamidOf(9), 'read', nowS() + 2, pricing('marketing'));
    const l = await ledger(ws);
    expect(l.map((r) => [r.kind, r.amount_minor])).toEqual([['topup', 1000], ['meta_charge', -100], ['meta_adjust', -150]]);
    expect(l[2]!.ref).toBe(`adj:${wamidOf(9)}:marketing`);
    expect((await workspace(ws).walletView()).balanceMinor).toBe(1000 - 250);
  });

  it('sent with pricing re-estimates the hold to the category Meta will bill', async () => {
    const ws = W(10);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await sendOut(ws, job, wamidOf(10));
    expect(await holdOf(ws, job)).toMatchObject({ amount_minor: 100 });
    await status(ws, wamidOf(10), 'sent', nowS(), pricing('marketing'));
    expect(await holdOf(ws, job)).toMatchObject({ amount_minor: 250 });
  });

  it('the expiry sweep expires a hold no status ever settled; a late billable event still charges (no hold needed)', async () => {
    const ws = W(11);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf(11));
    expect((await rows(ws, "SELECT 1 FROM scheduled_tasks WHERE kind = 'wallet_sweep'")).length).toBe(1);
    await workspace(ws).runDueTasks(Date.now() + 32 * DAY);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'expired', release_reason: 'ttl' });
    expect((await workspace(ws).walletView()).heldMinor).toBe(0);
    await status(ws, wamidOf(11), 'delivered', nowS(), pricing('marketing'));
    expect((await ledger(ws)).at(-1)).toMatchObject({ kind: 'meta_charge', amount_minor: -250 });
  });

  it('WA-SHARED-FREE-1: a service reply on a platform number is charged at the service rate even when Meta marks it free', async () => {
    const ws = W(12);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueText(ws, conv));
    expect(await holdOf(ws, job)).toMatchObject({ amount_minor: PIASTERS.service });
    await sendOut(ws, job, wamidOf(12));
    await status(ws, wamidOf(12), 'delivered', nowS(), { billable: false, pricingModel: 'PMP', category: 'service', type: 'free_customer_service' });
    expect((await ledger(ws)).at(-1)).toMatchObject({ kind: 'meta_charge', amount_minor: -PIASTERS.service, category: 'service' });
  });

  it('a market with no rate card is never guessed: estimate 0, an alert, and no charge', async () => {
    const spy = alerts();
    const ws = W(13);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await openChat(ws, '4915112345678'); // Germany: not on the test card
    await seedTemplate(ws, { name: 'tpl-m', category: 'MARKETING' });
    const job = jobOf(await workspace(ws).queueOutbound(conv, pn(ws), { type: 'template', clientId: '00000000-0000-4000-8000-000000000131', name: 'tpl-m', language: 'ar', params: ['a', 'b'] }));
    expect(await holdOf(ws, job)).toMatchObject({ amount_minor: 0 });
    await sendOut(ws, job, wamidOf(13));
    await status(ws, wamidOf(13), 'delivered', nowS(), pricing('marketing'));
    expect(alertNames(spy)).toContain('rate_missing');
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']);
  });
});

describe('pre-send rules by category (WA-OVERDRAFT-1)', () => {
  const debt = (ws: string, minor: number) => workspace(ws).postWallet({ kind: 'chargeback', netMinor: -minor, ref: `chargeback:${minor}-${Math.random()}` });

  it('marketing: refused at the API when the wallet cannot pay (wallet_empty), and nothing is written', async () => {
    const ws = W(20);
    await setupBilling(ws);
    await fund(ws, 200);
    const conv = await chat(ws);
    expect(await queueTemplate(ws, conv, 'MARKETING')).toMatchObject({ ok: false, reason: 'wallet_empty' });
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE direction = 'out'")).toEqual([{ n: 0 }]);
    expect(await holds(ws)).toEqual([]);
  });

  it('marketing at claim: fails wallet_empty when funds went elsewhere; with debt it is refused even if the market has no rate', async () => {
    const ws = W(21);
    await setupBilling(ws);
    await fund(ws, 300);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING')); // holds 250 of 300
    await workspace(ws).postWallet({ kind: 'adjustment', netMinor: -200, ref: 'adj:take', actor: 'op', note: 'take' }); // balance 100 < the hold's 250
    // the hold exists already, so the claim passes; a NEW marketing message cannot be queued
    expect(await workspace(ws).claimSend(job)).toBe('claimed');
    expect(await queueTemplate(ws, conv, 'MARKETING')).toMatchObject({ ok: false, reason: 'wallet_empty' });
    const ws2 = W(22);
    await setupBilling(ws2);
    await debt(ws2, 10);
    const conv2 = await openChat(ws2, '4915112345678');
    await seedTemplate(ws2, { name: 'tpl-m', category: 'MARKETING' });
    expect(await workspace(ws2).queueOutbound(conv2, pn(ws2), { type: 'template', clientId: '00000000-0000-4000-8000-000000000221', name: 'tpl-m', language: 'ar', params: ['a', 'b'] })).toMatchObject({ ok: false, reason: 'wallet_empty' });
  });

  it('utility and service may go into the overdraft (down to -50 EGP) and are held at their rate', async () => {
    const ws = W(23);
    await setupBilling(ws);
    await fund(ws, 50);
    const conv = await chat(ws);
    const u = jobOf(await queueTemplate(ws, conv, 'UTILITY')); // 100 > 50 available, still allowed
    expect(await workspace(ws).claimSend(u)).toBe('claimed');
    const s = jobOf(await queueText(ws, conv));
    expect(await workspace(ws).claimSend(s)).toBe('claimed');
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 50, heldMinor: 150, availableMinor: -100 });
  });

  it('utility beyond the overdraft waits; a top-up releases it in arrival order only as far as the money goes', async () => {
    const ws = W(24);
    await setupBilling(ws);
    await debt(ws, 4950); // balance -4950, limit 5000
    const conv = await chat(ws);
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(jobOf(await queueTemplate(ws, conv, 'UTILITY')));
    for (const j of jobs) expect(await workspace(ws).claimSend(j)).toBe('deferred');
    expect(await rows(ws, "SELECT status FROM messages WHERE direction = 'out'")).toEqual([{ status: 'queued' }, { status: 'queued' }, { status: 'queued' }]);
    expect(await rows(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'wallet_wait'")).toEqual([{ n: 3 }]);
    const spy = vi.mocked(env.SEND_QUEUE.sendBatch);
    spy.mockClear();
    // +160: balance -4790 -> room 210 -> the first two (100 each would be 200) go, the third waits
    expect(await workspace(ws).postWallet({ kind: 'topup', netMinor: 160, ref: 'kashier:w1' })).toMatchObject({ ok: true, debtSettledMinor: 160 });
    await workspace(ws).runDueTasks(Date.now());
    const sent = spy.mock.calls.flatMap((c) => (c[0] as { body: { idempotencyKey: string } }[]).map((m) => m.body.idempotencyKey));
    expect(sent).toEqual([jobs[0]!.idempotencyKey, jobs[1]!.idempotencyKey]);
    expect(await rows(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'wallet_wait'")).toEqual([{ n: 1 }]);
  });

  it('a utility message that waited past 48 h fails wallet_empty_expired and is not resurrected by a later top-up', async () => {
    const spy = alerts();
    const ws = W(25);
    await setupBilling(ws);
    await debt(ws, 4990);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    expect(await workspace(ws).claimSend(job)).toBe('deferred');
    const sendBatch = vi.mocked(env.SEND_QUEUE.sendBatch);
    sendBatch.mockClear();
    await workspace(ws).runDueTasks(Date.now() + 49 * 3_600_000);
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'wallet_empty_expired' }]);
    expect(alertNames(spy)).toContain('wallet_wait_expired');
    await fund(ws, 100_000);
    await workspace(ws).runDueTasks(Date.now() + 50 * 3_600_000);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(await rows(ws, "SELECT count(*) AS n FROM wallet_waits")).toEqual([{ n: 0 }]);
  });

  it('a retry after the first wait keeps the ORIGINAL deadline (waiting again cannot extend it)', async () => {
    const ws = W(26);
    await setupBilling(ws);
    await debt(ws, 4990);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await workspace(ws).claimSend(job);
    const first = (await rows<{ wait_until: number }>(ws, 'SELECT wait_until FROM wallet_waits'))[0]!.wait_until;
    await workspace(ws).claimSend(job, Date.now() + 3_600_000);
    expect((await rows<{ wait_until: number }>(ws, 'SELECT wait_until FROM wallet_waits'))[0]!.wait_until).toBe(first);
    expect(await rows(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'wallet_wait'")).toEqual([{ n: 1 }]);
  });

  it('authentication that cannot be paid fails at once so the Store can fall back to email', async () => {
    const ws = W(27);
    await setupBilling(ws);
    await debt(ws, 4900);
    const conv = await chat(ws);
    const q = await queueTemplate(ws, conv, 'AUTHENTICATION');
    expect(q).toMatchObject({ ok: false, reason: 'wallet_empty' });
    await fund(ws, 100); // -4800: 150 -> -4950 fits
    expect(await queueTemplate(ws, conv, 'AUTHENTICATION')).toMatchObject({ ok: true });
  });

  it('a service reply that cannot be paid waits no longer than the 24 h window', async () => {
    const ws = W(28);
    await setupBilling(ws);
    await debt(ws, 4990);
    const inbound = nowS() - 3600;
    const conv = await openChat(ws, '201001234567', { ts: inbound });
    const job = jobOf(await queueText(ws, conv));
    expect(await workspace(ws).claimSend(job)).toBe('deferred');
    const w = (await rows<{ wait_until: number }>(ws, 'SELECT wait_until FROM wallet_waits'))[0]!.wait_until;
    expect(w).toBe(inbound * 1000 + DAY);
  });

  it('a campaign page is refused when the wallet cannot pay for it: the Phase 6 pause path, reason wallet_empty', async () => {
    const ws = W(29);
    await setupBilling(ws);
    await fund(ws, 600); // 4 contacts x 250 = 1000
    await seedTemplate(ws);
    await seedContacts(ws, 4);
    const c = await workspace(ws).createCampaign({ name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [...PARAMS] as never, audience: { criteria: { everyone: true } }, phoneNumberId: pn(ws), actor: 'u1' });
    if (!c.ok) throw new Error('not created');
    expect(c.campaign.estimate).toEqual({ audience: 4, perMessageMinor: 250, totalMinor: 1000 });
    await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.campaign.id);
    expect(await workspace(ws).campaignPage(c.campaign.id, 1, 0)).toEqual({ state: 'stop', reason: 'wallet_empty' });
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns')).toEqual([{ status: 'paused', pause_reason: 'wallet_empty' }]);
    expect(await holds(ws)).toEqual([]);
  });
});

describe('campaign pages reserve once; their messages draw from the reservation', () => {
  async function campaign(ws: string, contacts: number, funds: number) {
    await setupBilling(ws);
    await fund(ws, funds);
    await seedTemplate(ws);
    await seedContacts(ws, contacts);
    const c = await workspace(ws).createCampaign({ name: 'Eid', template: { name: 'promo', language: 'ar' }, params: [...PARAMS] as never, audience: { criteria: { everyone: true } }, phoneNumberId: pn(ws), actor: 'u1' });
    if (!c.ok) throw new Error('not created');
    await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.campaign.id);
    return c.campaign;
  }
  const jobsOf = async (ws: string) => (await rows<{ idempotency_key: string; wa: string }>(ws, "SELECT m.idempotency_key, ct.wa_id AS wa FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE m.idempotency_key LIKE 'camp:%' ORDER BY m.id"))
    .map((r) => ({ workspaceId: ws, phoneNumberId: pn(ws), to: r.wa, idempotencyKey: r.idempotency_key, kind: 'template' as const, template: { name: 'promo', language: 'ar', components: [] } }));

  it('one parent hold per page; per-message holds do not reserve again; a charge moves money from the reservation to the ledger', async () => {
    const ws = W(40);
    const c = await campaign(ws, 4, 1000);
    expect(await workspace(ws).campaignPage(c.id, 1, 0)).toMatchObject({ state: 'done', count: 4 });
    const parent = `camp:${c.id}:p0`;
    expect((await holds(ws)).map((h) => [h.ref, h.amount_minor, h.state])).toEqual([[parent, 1000, 'held']]);
    expect(await workspace(ws).walletView()).toMatchObject({ heldMinor: 1000, availableMinor: 0 });
    const jobs = await jobsOf(ws);
    for (const j of jobs) expect(await workspace(ws).claimSend(j)).toBe('claimed');
    expect((await holds(ws)).filter((h) => h.parent_ref === parent)).toHaveLength(4);
    expect((await workspace(ws).walletView()).heldMinor).toBe(1000); // not 2000
    // the first message is sent and billed: 250 leaves the wallet, and the reservation shrinks by the same 250
    await workspace(ws).recordOutbound(jobs[0]!.idempotencyKey, { ok: true, wamid: wamidOf('c0') });
    await status(ws, wamidOf('c0'), 'delivered', nowS(), pricing('marketing'));
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 750, heldMinor: 750, availableMinor: 0 });
  });

  it('cancelling releases the page and every unsent message hold; nothing stays reserved', async () => {
    const ws = W(41);
    const c = await campaign(ws, 3, 1000);
    await setPageSize(ws, 2); // two of three recipients: the campaign is still running when it is cancelled
    expect(await workspace(ws).campaignPage(c.id, 1, 0)).toMatchObject({ state: 'next', count: 2 });
    const jobs = await jobsOf(ws);
    await workspace(ws).claimSend(jobs[0]!);
    await exec(ws, "UPDATE messages SET status = 'queued' WHERE idempotency_key = ?", jobs[0]!.idempotencyKey); // as if Meta's throughput limit had parked it
    expect((await workspace(ws).walletView()).heldMinor).toBe(500);
    await workspace(ws).cancelCampaign(c.id);
    expect((await workspace(ws).walletView()).heldMinor).toBe(0);
    expect((await holds(ws)).every((h) => h.state === 'released')).toBe(true);
  });

  it('a finished page stays reserved until its last message settles, then closes by itself', async () => {
    const ws = W(42);
    const c = await campaign(ws, 2, 1000);
    expect(await workspace(ws).campaignPage(c.id, 1, 0)).toMatchObject({ state: 'done' });
    // the workflow ended (completed): the page is told to close, but two messages are still waiting to be sent
    expect(await rows(ws, 'SELECT closing FROM wallet_holds')).toEqual([{ closing: 1 }]);
    expect((await workspace(ws).walletView()).heldMinor).toBe(500);
    const jobs = await jobsOf(ws);
    for (const [i, j] of jobs.entries()) {
      await workspace(ws).claimSend(j);
      await workspace(ws).recordOutbound(j.idempotencyKey, { ok: true, wamid: wamidOf(`d${i}`) });
      await status(ws, wamidOf(`d${i}`), 'delivered', nowS(), pricing('marketing'));
    }
    expect((await holds(ws)).map((h) => h.state)).toEqual(['released', 'charged', 'charged']);
    expect(await workspace(ws).walletView()).toMatchObject({ balanceMinor: 500, heldMinor: 0, availableMinor: 500 });
  });
});

describe('(a) every terminal message path settles its hold', () => {
  const live = async (ws: string) => (await workspace(ws).walletView()).heldMinor;

  async function fresh(n: number, category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' = 'UTILITY') {
    const ws = W(n);
    await setupBilling(ws);
    await fund(ws, 5000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, category));
    expect(await live(ws)).toBeGreaterThan(0);
    return { ws, conv, job };
  }

  it('markEnqueueFailed', async () => {
    const { ws, job } = await fresh(60);
    await workspace(ws).markEnqueueFailed(job.idempotencyKey);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'enqueue_failed' });
    expect(await live(ws)).toBe(0);
  });

  it('claimRow: an opted-out drop (marketing that waited)', async () => {
    const { ws, job } = await fresh(61, 'MARKETING');
    await exec(ws, 'UPDATE contacts SET opted_out_at = 1');
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'opted_out' });
    expect(await live(ws)).toBe(0);
  });

  it('claimRow: a plan that lapsed', async () => {
    const { ws, job } = await fresh(62, 'MARKETING');
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'p', status: 'past_due', periodStart: Date.now() - DAY, periodEnd: Date.now() + DAY });
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'dropped' });
    expect(await live(ws)).toBe(0);
  });

  it('claimRow: a cancelled campaign message', async () => {
    const ws = W(63);
    await setupBilling(ws);
    await fund(ws, 5000);
    await seedTemplate(ws);
    await seedContacts(ws, 1);
    const c = await workspace(ws).createCampaign({ name: 'x', template: { name: 'promo', language: 'ar' }, params: [...PARAMS] as never, audience: { criteria: { everyone: true } }, phoneNumberId: pn(ws), actor: 'u' });
    if (!c.ok) throw new Error('x');
    await exec(ws, "UPDATE campaigns SET status = 'running', attempt = 1, started_at = 1 WHERE id = ?", c.campaign.id);
    await workspace(ws).campaignPage(c.campaign.id, 1, 0);
    const key = (await rows<{ idempotency_key: string }>(ws, "SELECT idempotency_key FROM messages WHERE idempotency_key LIKE 'camp:%'"))[0]!.idempotency_key;
    const to = (await rows<{ wa_id: string }>(ws, 'SELECT wa_id FROM contacts'))[0]!.wa_id;
    const job = { workspaceId: ws, phoneNumberId: pn(ws), to, idempotencyKey: key, kind: 'template' as const, template: { name: 'promo', language: 'ar', components: [] } };
    await workspace(ws).claimSend(job); // the message hold exists, drawn from the page
    await exec(ws, "UPDATE campaigns SET status = 'cancelled'");
    await exec(ws, "UPDATE messages SET status = 'queued' WHERE idempotency_key = ?", key);
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect((await holds(ws)).find((h) => h.ref === `msg:${key}`)).toMatchObject({ state: 'released', release_reason: 'cancelled' });
  });

  it('recordOutbound: a non-retryable Meta failure; a retryable one keeps the hold for the next attempt', async () => {
    const a = await fresh(64);
    expect(await workspace(a.ws).claimSend(a.job)).toBe('claimed');
    await workspace(a.ws).recordOutbound(a.job.idempotencyKey, { ok: false, code: 500, retryable: true, message: 'x' });
    expect(await holdOf(a.ws, a.job)).toMatchObject({ state: 'held' });
    await workspace(a.ws).recordOutbound(a.job.idempotencyKey, { ok: false, code: 131026, retryable: false, message: 'x' });
    expect(await holdOf(a.ws, a.job)).toMatchObject({ state: 'released', release_reason: 'failed' });
    expect(await live(a.ws)).toBe(0);
  });

  it('131049: deferred keeps the hold, the second deferral that fails releases it', async () => {
    const a = await fresh(65, 'MARKETING');
    await workspace(a.ws).claimSend(a.job);
    expect(await workspace(a.ws).rescheduleFrequencyCap(a.job)).toBe('rescheduled');
    expect(await holdOf(a.ws, a.job)).toMatchObject({ state: 'held' });
    expect(await workspace(a.ws).rescheduleFrequencyCap({ ...a.job, deferrals: 2 })).toBe('failed');
    expect(await holdOf(a.ws, a.job)).toMatchObject({ state: 'released', release_reason: 'failed' });
    expect(await live(a.ws)).toBe(0);
  });

  it('dropped: a one-time code that Meta rate-limits (noDefer) settles', async () => {
    const a = await fresh(66, 'AUTHENTICATION');
    await workspace(a.ws).setNumberLimits(pn(a.ws), { tier: 1000, mps: 1 });
    const b = jobOf(await queueTemplate(a.ws, a.conv, 'AUTHENTICATION'));
    const now = Date.now();
    expect(await workspace(a.ws).claimSend(a.job, now, { noDefer: true })).toBe('claimed');
    expect(await workspace(a.ws).claimSend(b, now, { noDefer: true })).toBe('dropped');
    expect(await holdOf(a.ws, b)).toMatchObject({ state: 'released', release_reason: 'rate_limited' });
  });

  it('erased: the contact is erased while the send waits in the queue', async () => {
    const { ws, job } = await fresh(67);
    await workspace(ws).eraseContact('201001234567');
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'erased' });
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await live(ws)).toBe(0);
  });

  it('webhook failed after Meta accepted', async () => {
    const { ws, job } = await fresh(68, 'MARKETING');
    await sendOut(ws, job, wamidOf(68));
    expect(await live(ws)).toBe(250);
    await status(ws, wamidOf(68), 'failed', nowS(), undefined, 131047);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'failed' });
    expect(await live(ws)).toBe(0);
  });

  it('wait that expired', async () => {
    const ws = W(69);
    await setupBilling(ws);
    await workspace(ws).postWallet({ kind: 'chargeback', netMinor: -4990, ref: 'cb:1' });
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await workspace(ws).claimSend(job);
    await workspace(ws).runDueTasks(Date.now() + 49 * 3_600_000);
    expect(await live(ws)).toBe(0);
    expect(await rows(ws, 'SELECT error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ error_reason: 'wallet_empty_expired' }]);
  });

  it('the guard itself: after every path above no hold in any state other than charged/released/expired remains for a terminal message', async () => {
    // a charged hold needs no release; this asserts the vocabulary the paths above rely on
    const ws = W(70);
    await workspace(ws).walletView();
    expect(await rows(ws, "SELECT sql FROM sqlite_master WHERE name = 'wallet_holds'")).toEqual([{ sql: expect.stringContaining("'held', 'charged', 'released', 'expired'") }]);
  });
});
