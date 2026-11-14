import { Hono } from 'hono';
import { z } from 'zod';
import { verifyBridge } from '../../foundation/instapay-digest';
import { revertAutoConfirmed } from '../core/billing/instapay-auto';
import type { Env } from '../env';

/**
 * The OS brain's "not received" tap (InstaPay auto-confirm, C6). NOT an /api/v1 route: no merchant or operator session exists here, the HMAC IS the
 * authentication. The signature (direction `revert`, ts within 5 minutes) is checked over the RAW body BEFORE anything is parsed or written; a bad,
 * missing or stale one is a plain 401 with zero writes. A replayed valid request is harmless: the revert is idempotent (`already_reverted`).
 */
export const internalInstapayRoutes = new Hono<{ Bindings: Env }>();

const tap = z.object({ id: z.string().min(1).max(64), actor: z.string().min(1).max(64), tappedAt: z.number().int() }).strict();

internalInstapayRoutes.post('/instapay/auto-confirm/not-received', async (c) => {
  const raw = await c.req.text();
  const secret = c.env.INSTAPAY_BRIDGE_SECRET;
  const ok = !!secret && (await verifyBridge(secret, raw, Number(c.req.header('X-Bridge-Ts')), c.req.header('X-Bridge-Sig') ?? '', Date.now(), 'revert'));
  if (!ok) return c.json({ error: 'unauthorized' }, 401);
  const body = tap.safeParse((() => { try { return JSON.parse(raw); } catch { return null; } })());
  if (!body.success) return c.json({ error: 'invalid_request' }, 400);
  const r = await revertAutoConfirmed(c.env, { id: body.data.id, actor: body.data.actor, reason: 'not received (owner tap in the digest)' });
  if (r.ok) return c.json({ result: r.result, graceUntil: r.graceUntil });
  if (r.reason === 'not_found') return c.json({ error: 'not_found' }, 404);
  return c.json({ error: 'conflict', code: 'NOT_AUTO_CONFIRMED' }, 409);
});
