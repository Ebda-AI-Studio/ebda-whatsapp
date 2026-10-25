import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { chat, fund, holdOf, jobOf, queueTemplate, setupBilling, pn } from './helpers/billing';
import { consume } from './helpers/queue';
import { stubGraph } from './helpers/graph';
import { rows, workspace } from './helpers/workspace';

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
