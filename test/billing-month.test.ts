import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { monthOf } from '../src/core/billing/trueup';
import { monthRange } from '../src/core/billing/statement';
import { DAY, PIASTERS, chat, fund, holdOf, jobOf, ledger, nowS, pn, pricing, queueTemplate, queueText, sendOut, setupBilling, status, wamidOf } from './helpers/billing';
import { postWebhook } from './helpers/meta';
import { pricedStatusPayload, templateCategoryPayload } from './helpers/payload';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-0000000075${String(n).padStart(2, '0')}`;

describe('template_category_update', () => {
  it('a waiting utility message becomes marketing: opt-out is rechecked, the hold follows the new price, and an unaffordable one fails', async () => {
    const ws = W(1);
    await setupBilling(ws);
    await fund(ws, 450);
    const conv = await chat(ws, 'UTILITY', '201001230001');
    const ok = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    const conv2 = await chat(ws, 'UTILITY', '201001230002');
    const optedOut = jobOf(await queueTemplate(ws, conv2, 'UTILITY'));
    await exec(ws, "UPDATE contacts SET opted_out_at = 1 WHERE wa_id = '201001230002'");
    const conv3 = await chat(ws, 'UTILITY', '201001230003');
    const poor = jobOf(await queueTemplate(ws, conv3, 'UTILITY'));
    expect(await workspace(ws).walletView()).toMatchObject({ heldMinor: 300 }); // 3 x 100
    const r = await workspace(ws).applyTemplateCategory('tpl-u', 'ar', 'MARKETING');
    expect(r).toEqual({ rechecked: 3, failed: 2 });
    expect((await rows<{ idempotency_key: string; status: string; error_reason: string | null }>(ws, "SELECT idempotency_key, status, error_reason FROM messages WHERE template_name = 'tpl-u' ORDER BY id")).map((m) => [m.status, m.error_reason])).toEqual([
      ['queued', null], ['failed', 'opted_out'], ['failed', 'wallet_empty'],
    ]);
    expect(await holdOf(ws, ok)).toMatchObject({ amount_minor: 250, state: 'held' });
    expect(await holdOf(ws, optedOut)).toMatchObject({ state: 'released' });
    expect(await holdOf(ws, poor)).toMatchObject({ state: 'released' });
    expect(await rows(ws, "SELECT category FROM templates WHERE name = 'tpl-u'")).toEqual([{ category: 'MARKETING' }]);
  });

  it('a template that became cheaper gives the difference back; the same category again changes nothing', async () => {
    const ws = W(2);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const j = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    expect(await workspace(ws).applyTemplateCategory('tpl-m', 'ar', 'UTILITY')).toEqual({ rechecked: 1, failed: 0 });
    expect(await holdOf(ws, j)).toMatchObject({ amount_minor: PIASTERS.utility, state: 'held' });
    expect(await workspace(ws).applyTemplateCategory('tpl-m', 'ar', 'UTILITY')).toEqual({ rechecked: 0, failed: 0 });
    expect(await workspace(ws).applyTemplateCategory('nope', 'ar', 'UTILITY')).toEqual({ rechecked: 0, failed: 0 });
  });

  it('arrives over the signed webhook for every workspace on that WABA', async () => {
    const ws = W(3);
    await setupBilling(ws);
    await env.DB.prepare("UPDATE phone_numbers SET waba_id = 'waba-cat3' WHERE workspace_id = ?").bind(ws).run();
    await chat(ws);
    const res = await postWebhook(SELF, templateCategoryPayload('waba-cat3', { name: 'tpl-u', language: 'ar', previous: 'UTILITY', next: 'MARKETING' }));
    expect(res.status).toBe(200);
    expect(await rows(ws, "SELECT category FROM templates WHERE name = 'tpl-u'")).toEqual([{ category: 'MARKETING' }]);
  });
});

describe('pricing objects over the real webhook route', () => {
  it('a signed status webhook with a pricing object charges once, however many times Meta retries it', async () => {
    const ws = W(5);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, job, wamidOf('hook'));
    const body = pricedStatusPayload(pn(ws), wamidOf('hook'), 'delivered', { billable: true, pricing_model: 'PMP', category: 'marketing' }, nowS());
    for (let i = 0; i < 3; i++) expect((await postWebhook(SELF, body)).status).toBe(200);
    expect((await ledger(ws)).filter((r) => r.kind === 'meta_charge')).toHaveLength(1);
    expect(await rows(ws, 'SELECT pricing_json FROM message_status_events')).toEqual([{ pricing_json: JSON.stringify({ billable: true, pricingModel: 'PMP', category: 'marketing', type: null }) }]);
  });
});

describe('WA-SHARED-FREE-1: month-close true-up', () => {
  const NUM = 'pn-shared-1';
  async function sharedWorkspace(n: number, replies: number) {
    const ws = W(n);
    await setupBilling(ws);
    await exec(ws, 'INSERT OR REPLACE INTO number_funding (phone_number_id, funding) VALUES (?, ?)', NUM, 'platform_line');
    await fund(ws, 5000);
    const conv = await chat(ws);
    for (let i = 0; i < replies; i++) {
      const job = jobOf(await workspace(ws).queueOutbound(conv, NUM, { type: 'text', clientId: `00000000-0000-4000-8000-0000000${String(n)}${String(i).padStart(5, '0')}`, text: `r${i}` }));
      expect(await sendOut(ws, job, wamidOf(`sh${n}-${i}`))).toBe('sent');
      await status(ws, wamidOf(`sh${n}-${i}`), 'delivered', nowS(), { billable: false, pricingModel: 'PMP', category: 'service', type: 'free_customer_service' });
    }
    return ws;
  }

  it('each workspace reports its service charges, waits for the published true-up, then rebates its pro-rata share once', async () => {
    const a = await sharedWorkspace(10, 3); // 3 x 50
    const b = await sharedWorkspace(11, 1); // 1 x 50
    const month = monthOf(Date.now());
    const closeAt = monthRange(month)!.to + 3 * 3_600_000;
    expect(await rows(a, "SELECT json_extract(payload, '$.month') AS m FROM scheduled_tasks WHERE kind = 'shared_number_trueup'")).toEqual([{ m: month }]);
    await workspace(a).runDueTasks(closeAt);
    await workspace(b).runDueTasks(closeAt);
    expect((await env.DB.prepare('SELECT workspace_id, charged_minor, service_count FROM shared_number_usage WHERE month = ? ORDER BY workspace_id').bind(month).all()).results).toEqual([
      { workspace_id: a, charged_minor: 150, service_count: 3 }, { workspace_id: b, charged_minor: 50, service_count: 1 },
    ]);
    expect((await ledger(a)).some((r) => r.ref.startsWith('trueup:'))).toBe(false); // nothing published yet: the task waits a day
    expect(await rows(a, "SELECT due_at FROM scheduled_tasks WHERE kind = 'shared_number_trueup'")).toEqual([{ due_at: closeAt + DAY }]);
    // the operator enters what Meta really billed for the number: 80 of the 200 charged -> 120 to give back, 4 billable replies
    await env.DB.prepare('INSERT INTO shared_trueups (month, phone_number_id, actual_minor, total_charged_minor, total_count, rebate_minor, actor, published_at) VALUES (?, ?, 80, 200, 4, 120, ?, 1)').bind(month, NUM, 'op-1').run();
    await workspace(a).runDueTasks(closeAt + DAY);
    await workspace(b).runDueTasks(closeAt + DAY);
    const ra = (await ledger(a)).find((r) => r.ref === `trueup:${month}:${a}`);
    const rb = (await ledger(b)).find((r) => r.ref === `trueup:${month}:${b}`);
    expect(ra).toMatchObject({ kind: 'meta_adjust', amount_minor: 90 }); // 120 x 3/4
    expect(rb).toMatchObject({ kind: 'meta_adjust', amount_minor: 30 }); // 120 x 1/4
    await workspace(a).runDueTasks(closeAt + 5 * DAY);
    expect((await ledger(a)).filter((r) => r.ref.startsWith('trueup:'))).toHaveLength(1); // finished: never twice
    await expect(env.DB.prepare('UPDATE shared_trueups SET rebate_minor = 0').run()).rejects.toThrow(/immutable/);
  });

  it('no rebate when Meta billed as much as was charged; a number a workspace never used is ignored', async () => {
    const a = await sharedWorkspace(12, 1);
    const month = monthOf(Date.now());
    const closeAt = monthRange(month)!.to + 3 * 3_600_000;
    await env.DB.prepare('INSERT OR REPLACE INTO shared_trueups (month, phone_number_id, actual_minor, total_charged_minor, total_count, rebate_minor, actor, published_at) VALUES (?, ?, 999, 50, 1, 0, ?, 1)').bind(month, NUM, 'op-1').run().catch(() => undefined);
    await workspace(a).runDueTasks(closeAt);
    expect((await ledger(a)).some((r) => r.ref.startsWith('trueup:'))).toBe(false);
  });

  it('a month with no true-up after 25 days alerts and stops instead of waiting forever', async () => {
    const a = await sharedWorkspace(13, 1);
    const month = monthOf(Date.now());
    const closeAt = monthRange(month)!.to;
    await workspace(a).runDueTasks(closeAt + 26 * DAY);
    expect(await rows(a, "SELECT 1 FROM scheduled_tasks WHERE kind = 'shared_number_trueup'")).toEqual([]);
  });
});

describe('own cost figure for the monthly reconcile against Meta', () => {
  it('sums what the billing flags say Meta billed per platform number', async () => {
    const ws = W(20);
    await setupBilling(ws);
    await fund(ws, 5000);
    const conv = await chat(ws);
    const j = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    await sendOut(ws, j, wamidOf('rc'));
    await status(ws, wamidOf('rc'), 'delivered', nowS(), pricing('marketing'));
    const { metaCostUsdMicros } = await import('../src/core/billing/trueup');
    const { runInDurableObject } = await import('cloudflare:test');
    const got = await runInDurableObject(workspace(ws), (_i, s) => metaCostUsdMicros(s.storage.sql, monthOf(Date.now())));
    expect(got).toEqual([{ numberId: pn(ws), usdMicros: 50_000, messages: 1 }]);
  });
});
