import { Hono } from 'hono';
import { verifyProofSig } from '../core/ordering/proof-url';
import type { Env } from '../env';
import { storeLink } from '../core/store-link';

/**
 * GET /api/v1/proof/:workspaceId/:messageId?exp&sig - a customer's payment screenshot for the Store. No login: the signed,
 * expiring link (minted only when the bot forwards a receipt) is the authorisation, and it names exactly one message.
 */
export const proofRoutes = new Hono<{ Bindings: Env }>();

proofRoutes.get('/proof/:workspaceId/:messageId', async (c) => {
  const secret = storeLink().proof(c.env)?.secret;
  const workspaceId = c.req.param('workspaceId');
  const messageId = Number(c.req.param('messageId'));
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig') ?? '';
  const notFound = () => c.json({ error: 'not_found' }, 404);
  if (!secret || !Number.isSafeInteger(messageId) || messageId < 1 || !/^[0-9a-f]{64}$/.test(sig)) return notFound();
  if (!(await verifyProofSig({ secret, workspaceId, messageId, exp, sig, now: Date.now() }))) return notFound();
  const known = await c.env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(workspaceId).first();
  if (!known) return notFound();
  const media = await c.env.WORKSPACE_DO.get(c.env.WORKSPACE_DO.idFromName(workspaceId)).getMedia(messageId);
  if (!media || !media.mime.startsWith('image/')) return notFound();
  const obj = await c.env.MEDIA.get(media.key);
  if (!obj) return notFound();
  return new Response(obj.body, { headers: { 'content-type': media.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline' } });
});
