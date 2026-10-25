import { createExecutionContext, createMessageBatch, env, getQueueResult, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker, { WhatsAppOtp } from '../src/index';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { fundingStatement } from '../src/core/billing/funding';
import { joinShared } from '../src/core/shared/shared-number';
import { fund, setupBilling } from './helpers/billing';
import { stubGraph } from './helpers/graph';
import { BUYER_KEY_1, PHONE_1, sentJobs, storeEvent, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-00000000e${String(n).padStart(3, '0')}`;
const PLAT = '5559101';
const on = { ...env, SHARED_NUMBER_ENABLED: 'true' } as typeof env;

/** A store with NO number of its own that joined the shared platform number, with a funded wallet and the default templates. */
async function sharedOnlyStore(n: number): Promise<string> {
  const ws = W(n);
  await setupBilling(W(n + 500)); // publishes the test rate card and FX (global)
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO shared_numbers (phone_number_id, waba_id, display_phone, created_at) VALUES (?, 'waba-plat', '+20 100 555 9101', 1)").bind(PLAT),
    fundingStatement(env.DB, PLAT, 'platform_line', 1),
    env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, `store ${n}`),
  ]);
  for (const t of EBDA_DEFAULT_TEMPLATES) {
    await exec(ws, "INSERT OR REPLACE INTO templates (name, language, category, status, components, updated_at) VALUES (?, ?, ?, 'APPROVED', ?, 1)", t.name, t.language, t.category, JSON.stringify(t.components));
  }
  expect(await joinShared(on, ws, `Shop ${n}`)).toMatchObject({ member: true });
  await fund(ws, 100_000);
  return ws;
}

async function deliverOn(events: unknown[]) {
  const batch = createMessageBatch('ebda-wa-events', events.map((body, i) => ({ id: `e${i}`, timestamp: new Date(), attempts: 1, body })));
  const ctx = createExecutionContext();
  await worker.queue(batch, on, ctx);
  return getQueueResult(batch, ctx);
}

describe('Final review: shared-only members', () => {
  it('a COD confirmation for a shared-only store goes out through the platform number with the order ref recorded', async () => {
    const ws = await sharedOnlyStore(1);
    const cod = storeEvent(ws, 'order.cod_confirmation_requested', { orderId: 'o9', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', deadlineAt: new Date(Date.now() + 86_400_000).toISOString(), orderNumber: '1001', totalMinor: 75_050, currency: 'EGP' });
    expect((await deliverOn([cod])).explicitAcks).toEqual(['e0']);
    await workspace(ws).runDueTasks();
    const job = sentJobs().find((j) => j.idempotencyKey === 'cod:o9');
    expect(job).toMatchObject({ phoneNumberId: PLAT, orderRef: 'o9', kind: 'template' });
    expect(await rows(ws, "SELECT status FROM messages WHERE idempotency_key = 'cod:o9'")).toEqual([{ status: 'queued' }]);
  });

  it('cart recovery is marketing and never goes out on the shared platform number: it is skipped with a clear reason', async () => {
    const ws = await sharedOnlyStore(2);
    await exec(ws, "INSERT INTO contacts (wa_id, profile_name, consent_source, consent_at) VALUES ('201001234567', 'c', 'store', 1)");
    const cart = storeEvent(ws, 'cart.abandoned', { cartId: 'c9', buyerKey: BUYER_KEY_1, phoneE164: PHONE_1, locale: 'ar', recoveryUrl: 'https://shop.example/cart/x' });
    const log = vi.spyOn(console, 'log');
    await deliverOn([cart]);
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes('"store_event"') && l.includes('shared_number_no_marketing'))).toBe(true);
    log.mockRestore();
    await workspace(ws).runDueTasks();
    expect(sentJobs().find((j) => j.idempotencyKey === 'cart:c9')).toBeUndefined();
    expect(await rows(ws, "SELECT count(*) AS n FROM messages WHERE idempotency_key = 'cart:c9'")).toEqual([{ n: 0 }]);
  });

  it('a one-time code is never sent on the shared number: refused, nothing queued, no shared route written', async () => {
    const ws = await sharedOnlyStore(3);
    await workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: true });
    await runInDurableObject(workspace(ws), (inst) => { (inst as unknown as { env: { SHARED_NUMBER_ENABLED?: string } }).env.SHARED_NUMBER_ENABLED = 'true'; });
    const g = stubGraph();
    try {
      expect(await new WhatsAppOtp(createExecutionContext(), on).sendOtp(ws, '+201001234567', 'K7Q93X')).toEqual({ ok: false, reason: 'no_number' });
      expect(g.calls.filter((c) => c.method === 'POST')).toEqual([]);
    } finally { g.restore(); }
    expect(await rows(ws, 'SELECT 1 FROM messages')).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM shared_routes WHERE workspace_id = ?').bind(ws).first<{ n: number }>())!.n).toBe(0);
  });
});
