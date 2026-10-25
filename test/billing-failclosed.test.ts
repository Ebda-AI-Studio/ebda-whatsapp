import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { PARAMS, seedContacts, seedTemplate } from './helpers/campaigns';
import { chat, fund, holdOf, jobOf, ledger, nowS, pn, pricing, queueTemplate, queueText, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { recordNumberFunding } from '../src/core/billing/funding';
import { exec, openChat, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000076${String(n).padStart(2, '0')}`;
const spyAlerts = () => vi.spyOn(console, 'error');
const names = (s: ReturnType<typeof spyAlerts>) => s.mock.calls.map((c) => { try { return (JSON.parse(String(c[0])) as { alert?: string }).alert; } catch { return undefined; } });

describe('funding must be KNOWN: a missing row is never "free"', () => {
  it('no funding row anywhere: the API refuses, a queued send is failed funding_unknown, and an alert fires', async () => {
    const spy = spyAlerts();
    const ws = W(1);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    await exec(ws, "INSERT INTO messages (conversation_id, direction, type, status, idempotency_key, template_name, template_lang, created_at, updated_at) VALUES (?, 'out', 'template', 'queued', 'k-nofunding', 'tpl-u', 'ar', 1, 1)", conv);
    const queued = { workspaceId: ws, phoneNumberId: pn(ws), to: '201001234567', idempotencyKey: 'k-nofunding', kind: 'template' as const, template: { name: 'tpl-u', language: 'ar', components: [] } };
    await env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(pn(ws)).run();
    await exec(ws, 'DELETE FROM number_funding');
    expect(await queueTemplate(ws, conv, 'MARKETING')).toMatchObject({ ok: false, reason: 'funding_unknown' });
    expect(await workspace(ws).claimSend(queued)).toBe('dropped');
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', queued.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'funding_unknown' }]);
    expect(names(spy)).toContain('funding_unknown');
  });

  it('a row missing from the workspace copy but present in D1 heals itself with an immediate re-pull', async () => {
    const ws = W(2);
    await setupBilling(ws, { funding: 'merchant_card' });
    const conv = await chat(ws);
    await exec(ws, 'DELETE FROM number_funding'); // the copy is stale: the number was connected after the last pull
    expect(await sendOut(ws, jobOf(await queueTemplate(ws, conv, 'MARKETING')), wamidOf('heal'))).toBe('sent');
  });

  it('a campaign on a number with unknown funding pauses (funding_unknown) before reserving anything', async () => {
    const ws = W(3);
    await setupBilling(ws);
    await fund(ws, 5000);
    await seedTemplate(ws);
    await seedContacts(ws, 2);
    const c = await workspace(ws).createCampaign({ name: 'x', template: { name: 'promo', language: 'ar' }, params: [...PARAMS] as never, audience: { criteria: { everyone: true } }, phoneNumberId: pn(ws), actor: 'u' });
    if (!c.ok) throw new Error('x');
    await exec(ws, "UPDATE campaigns SET status = 'running', started_at = 1, attempt = 1 WHERE id = ?", c.campaign.id);
    await env.DB.prepare('DELETE FROM number_funding WHERE phone_number_id = ?').bind(pn(ws)).run();
    await exec(ws, 'DELETE FROM number_funding');
    expect(await workspace(ws).campaignPage(c.campaign.id, 1, 0)).toEqual({ state: 'stop', reason: 'funding_unknown' });
    expect(await rows(ws, 'SELECT status, pause_reason FROM campaigns')).toEqual([{ status: 'paused', pause_reason: 'funding_unknown' }]);
  });
});

describe('connecting a number does not stamp its funding', () => {
  it('a phone_numbers row inserted without a funding write stays unknown: its sends are refused (no trigger, no backfill)', async () => {
    const ws = W(10);
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 0)').bind(ws, ws),
      env.DB.prepare("INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, status) VALUES ('pn-raw-10', 'waba-1', ?, 'active')").bind(ws),
    ]);
    expect(await env.DB.prepare("SELECT 1 FROM number_funding WHERE phone_number_id = 'pn-raw-10'").first()).toBeNull();
    const conv = await chat(ws);
    expect(await workspace(ws).queueOutbound(conv, 'pn-raw-10', { type: 'text', clientId: '00000000-0000-4000-8000-000000001010', text: 'x' })).toMatchObject({ ok: false, reason: 'funding_unknown' });
    // recording the funding is what makes it sendable
    await recordNumberFunding(env, 'pn-raw-10', 'merchant_card');
    await workspace(ws).refreshPricing();
    expect(await workspace(ws).queueOutbound(conv, 'pn-raw-10', { type: 'text', clientId: '00000000-0000-4000-8000-000000001011', text: 'x' })).toMatchObject({ ok: true });
    expect(await env.DB.prepare("SELECT funding FROM number_funding WHERE phone_number_id = 'pn-raw-10'").first()).toEqual({ funding: 'merchant_card' });
  });
});

describe('an empty pricing copy never decides', () => {
  it('when the first pull fails nothing is sent: claims defer (a retry is scheduled) and the API refuses; once D1 answers it all goes through', async () => {
    const ws = W(4);
    await setupBilling(ws, { funding: 'merchant_card' });
    await exec(ws, "DELETE FROM store_state WHERE key = 'pricing.pulled_at'"); // as a workspace that never pulled
    await exec(ws, 'DELETE FROM number_funding');
    const conv = await chat(ws);
    const real = await runInDurableObject(workspace(ws), (inst) => (inst as unknown as { env: { DB: D1Database } }).env.DB);
    const broken = { ...env, DB: { prepare: real.prepare.bind(real), batch: async () => { throw new Error('d1 down'); } } };
    await runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { env: unknown }).env = broken; (inst as unknown as { pricingPulledAt: number }).pricingPulledAt = 0; });
    const job = { workspaceId: ws, phoneNumberId: pn(ws), to: '201001234567', text: 'hi', idempotencyKey: 'reply:early' };
    expect(await workspace(ws).claimSend(job)).toBe('deferred');
    expect(await rows(ws, "SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'send_release'")).toEqual([{ n: 1 }]);
    expect(await queueTemplate(ws, conv, 'UTILITY')).toMatchObject({ ok: false, reason: 'funding_unknown' });
    await runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { env: unknown }).env = env; (inst as unknown as { pricingPulledAt: number }).pricingPulledAt = 0; });
    expect(await workspace(ws).claimSend(job)).toBe('claimed');
  });
});

describe('platform-paid numbers need a rate in effect', () => {
  it('no rate for (market, category): refused at the API (rate_unavailable) and at claim, with an alert; never held at 0', async () => {
    const spy = spyAlerts();
    const ws = W(5);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await openChat(ws, '4915112345678'); // Germany is not on the card
    await seedTemplate(ws, { name: 'tpl-m', category: 'MARKETING' });
    const req = { type: 'template' as const, clientId: '00000000-0000-4000-8000-000000000551', name: 'tpl-m', language: 'ar', params: ['a', 'b'] };
    expect(await workspace(ws).queueOutbound(conv, pn(ws), req)).toMatchObject({ ok: false, reason: 'rate_unavailable' });
    expect(await rows(ws, "SELECT count(*) AS n FROM wallet_holds")).toEqual([{ n: 0 }]);
    // service text in the same chat is refused too
    expect(await workspace(ws).queueOutbound(conv, pn(ws), { type: 'text', clientId: '00000000-0000-4000-8000-000000000552', text: 'x' })).toMatchObject({ ok: false, reason: 'rate_unavailable' });
    // and a message that was queued some other way is failed at claim
    await exec(ws, "INSERT INTO messages (conversation_id, direction, type, status, idempotency_key, template_name, template_lang, created_at, updated_at) VALUES (?, 'out', 'template', 'queued', 'k-norate', 'tpl-m', 'ar', 1, 1)", conv);
    const job = { workspaceId: ws, phoneNumberId: pn(ws), to: '4915112345678', idempotencyKey: 'k-norate', kind: 'template' as const, template: { name: 'tpl-m', language: 'ar', components: [] } };
    expect(await workspace(ws).claimSend(job)).toBe('dropped');
    expect(await rows(ws, "SELECT error_reason FROM messages WHERE idempotency_key = 'k-norate'")).toEqual([{ error_reason: 'rate_unavailable' }]);
    expect(names(spy)).toContain('rate_unavailable');
  });

  it('a merchant-card number is unaffected by a missing rate', async () => {
    const ws = W(6);
    await setupBilling(ws, { funding: 'merchant_card' });
    const conv = await openChat(ws, '4915112345678');
    await seedTemplate(ws, { name: 'tpl-m', category: 'MARKETING' });
    const q = await workspace(ws).queueOutbound(conv, pn(ws), { type: 'template', clientId: '00000000-0000-4000-8000-000000000661', name: 'tpl-m', language: 'ar', params: ['a', 'b'] });
    expect(await sendOut(ws, jobOf(q), wamidOf('de'))).toBe('sent');
  });

  async function pendingDelivery(ws: string, n: string, wa = '966501234567', country = 'SA') {
    await setupBilling(ws, { rates: [{ country, category: 'utility', usd: 100_000, ver: 1 }] });
    await fund(ws, 5000);
    const conv = await openChat(ws, wa);
    await seedTemplate(ws, { name: 'tpl-u', category: 'UTILITY', components: JSON.stringify([{ type: 'BODY', text: 'hi' }]) });
    const j = jobOf(await workspace(ws).queueOutbound(conv, pn(ws), { type: 'template', clientId: `00000000-0000-4000-8000-0000000007${n}`, name: 'tpl-u', language: 'ar', params: [] }));
    await sendOut(ws, j, wamidOf(`pr${n}`));
    await status(ws, wamidOf(`pr${n}`), 'delivered', nowS(), pricing('marketing')); // Meta bills it as marketing: no SA marketing rate yet
    return j;
  }

  it('a billable delivery whose rate cannot be found keeps its hold (pending_rate); a rate effective from the past charges it exactly once', async () => {
    const spy = spyAlerts();
    const ws = W(7);
    const j = await pendingDelivery(ws, '71');
    expect((await ledger(ws)).map((r) => r.kind)).toEqual(['topup']);
    expect(await rows(ws, 'SELECT pending_rate, unpriced FROM billable_sends')).toEqual([{ pending_rate: 1, unpriced: 0 }]);
    expect(await holdOf(ws, j)).toMatchObject({ state: 'held', amount_minor: 500 }); // still reserved: not free while we wait
    expect(names(spy)).toContain('rate_missing_pending');
    await env.DB.prepare("INSERT INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (2, 0, 'SA', 'marketing', 200000, 0, 'op')").run();
    await workspace(ws).refreshPricing();
    await workspace(ws).refreshPricing();
    await workspace(ws).runDueTasks(Date.now() + 2 * 3_600_000);
    const charges = (await ledger(ws)).filter((r) => r.kind === 'meta_charge');
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amount_minor: -1000, ref: `meta:${wamidOf('pr71')}`, rate_ver: 2 });
    expect(await rows(ws, 'SELECT pending_rate FROM billable_sends')).toEqual([{ pending_rate: 0 }]);
    expect(await holdOf(ws, j)).toMatchObject({ state: 'charged' });
  });

  it('a rate that only takes effect AFTER the delivery (published 24 h ahead) still prices it: the earliest later version is used and recorded', async () => {
    const ws = W(8);
    const j = await pendingDelivery(ws, '81', '971501234567', 'AE');
    const later = Date.now() + 30 * 86_400_000;
    await env.DB.prepare("INSERT INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (3, ?, 'AE', 'marketing', 300000, 0, 'op')").bind(later).run();
    await env.DB.prepare("INSERT INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (4, ?, 'AE', 'marketing', 900000, 0, 'op')").bind(later + 86_400_000).run();
    await workspace(ws).refreshPricing();
    await workspace(ws).refreshPricing();
    const charges = (await ledger(ws)).filter((r) => r.kind === 'meta_charge');
    expect(charges).toHaveLength(1); // charged as soon as the version is known, once
    expect(charges[0]).toMatchObject({ amount_minor: -1500, rate_ver: 3 }); // 300000 usd micros x 50 EGP = 15 EGP; not the dearer v4
    expect(await holdOf(ws, j)).toMatchObject({ state: 'charged' });
    await workspace(ws).runDueTasks(Date.now() + 2 * 3_600_000);
    expect((await ledger(ws)).filter((r) => r.kind === 'meta_charge')).toHaveLength(1);
  });

  it('no rate ever: after 7 days the sweep charges the held estimate and alerts, so the send is never free', async () => {
    const spy = spyAlerts();
    const ws = W(9);
    const j = await pendingDelivery(ws, '91', '96550000001', 'KW');
    await workspace(ws).runDueTasks(Date.now() + 8 * 86_400_000);
    const charges = (await ledger(ws)).filter((r) => r.kind === 'meta_charge');
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amount_minor: -500, ref: `meta:${wamidOf('pr91')}` });
    expect(await holdOf(ws, j)).toMatchObject({ state: 'charged' });
    expect(names(spy)).toContain('rate_missing_estimate_charged');
  });
});
