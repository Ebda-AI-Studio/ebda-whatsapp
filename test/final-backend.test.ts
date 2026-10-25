import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chat, fund, holdOf, jobOf, queueTemplate, setupBilling, pn } from './helpers/billing';
import { consume } from './helpers/queue';
import { stubGraph } from './helpers/graph';
import { exec, rows, workspace } from './helpers/workspace';

const W = (n: number) => `00000000-0000-4000-8000-00000000f${String(n).padStart(3, '0')}`;

describe('Final review: send queue', () => {
  it('a queued send whose sender number is gone is failed with sender_unavailable and its wallet hold released', async () => {
    const ws = W(1);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'MARKETING'));
    expect((await workspace(ws).walletView()).heldMinor).toBeGreaterThan(0);
    await env.DB.prepare("UPDATE phone_numbers SET status = 'disconnected' WHERE phone_number_id = ?").bind(pn(ws)).run();
    const g = stubGraph();
    try {
      const res = await consume([job]);
      expect(res.explicitAcks).toEqual(['m0']);
      expect(g.calls).toHaveLength(0);
    } finally { g.restore(); }
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'sender_unavailable' }]);
    expect(await holdOf(ws, job)).toMatchObject({ state: 'released', release_reason: 'sender_unavailable' });
    expect((await workspace(ws).walletView()).heldMinor).toBe(0);
  });

  it('markEnqueueFailed records error_reason enqueue_failed', async () => {
    const ws = W(3);
    await setupBilling(ws);
    await fund(ws, 1000);
    const conv = await chat(ws);
    const job = jobOf(await queueTemplate(ws, conv, 'UTILITY'));
    await workspace(ws).markEnqueueFailed(job.idempotencyKey);
    expect(await rows(ws, 'SELECT status, error_reason FROM messages WHERE idempotency_key = ?', job.idempotencyKey)).toEqual([{ status: 'failed', error_reason: 'enqueue_failed' }]);
  });
});

describe('Final review: a workspace with no entitlement fails closed for marketing', () => {
  it('no entitlement row: a marketing template is plan_blocked; utility and an inbox text reply still go', async () => {
    const ws = W(20);
    await setupBilling(ws);
    await fund(ws, 5000);
    const conv = await chat(ws);
    await exec(ws, 'DELETE FROM entitlements'); // helpers give every workspace a baseline plan; this one has none
    expect(await rows(ws, 'SELECT 1 FROM entitlements')).toEqual([]);
    expect(await queueTemplate(ws, conv, 'MARKETING')).toMatchObject({ ok: false, reason: 'plan_blocked' });
    expect(await queueTemplate(ws, conv, 'UTILITY')).toMatchObject({ ok: true });
    expect(await workspace(ws).queueOutbound(conv, pn(ws), { type: 'text', clientId: crypto.randomUUID(), text: 'hi' })).toMatchObject({ ok: true });
  });

  it('with an active entitlement row the same marketing template is queued', async () => {
    const ws = W(21);
    await setupBilling(ws);
    await fund(ws, 5000);
    const conv = await chat(ws);
    await workspace(ws).applyEntitlement({ version: 1, packageId: 'p', status: 'active', periodStart: Date.now() - 1000, periodEnd: Date.now() + 86_400_000 });
    expect(await queueTemplate(ws, conv, 'MARKETING')).toMatchObject({ ok: true });
  });
});
