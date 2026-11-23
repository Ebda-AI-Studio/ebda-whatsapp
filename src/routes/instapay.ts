import { Hono } from 'hono';
import { instapayContest, instapayCreate } from '../core/api/contract';
import { MAX_PROOF_BYTES, cancelInstapay, contestInstapay, createInstapayRequest, instapayEnabled, listForWorkspace, markRejectionsSeen, readProof, storeProof } from '../core/billing/instapay';
import type { InstapayPayee, SelfDecision } from '../core/billing/instapay';
import { revertNotice } from '../core/billing/instapay-auto';
import { brandPack } from '../brand';
import type { Env } from '../env';
import { apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

/** The brand's InstaPay account for billing, or null when it has none (InstaPay billing is then unavailable, never half-shown). */
export const payeeFor = (env: Env): InstapayPayee | null => brandPack(env.BRAND).instapayPayee?.(env as unknown as Record<string, string | undefined>) ?? null;

/** The auto-confirm attempt runs after the response (`waitUntil`); with no execution context (a test) it is awaited inline. */
function afterResponse(c: ApiContext): ((p: Promise<unknown>) => void) | undefined {
  try { return c.executionCtx.waitUntil.bind(c.executionCtx); } catch { return undefined; }
}

export const instapayRoutes = new Hono<ApiEnv>();
const owner = (c: ApiContext) => c.get('storeRole') === 'owner';

instapayRoutes.get('/stores/:storeId/wallet/instapay', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!instapayEnabled(c.env)) return apiError(c, 404, 'not_found');
  const items = await listForWorkspace(c.env, c.req.param('storeId')!);
  await markRejectionsSeen(c.env, c.req.param('storeId')!); // opening the card is seeing the reason: the inbox notice clears
  return c.json({ enabled: true, payee: payeeFor(c.env), items, revert: await revertNotice(c.env, c.req.param('storeId')!) });
});

instapayRoutes.post('/stores/:storeId/wallet/instapay', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!instapayEnabled(c.env)) return apiError(c, 404, 'not_found');
  const body = instapayCreate.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const p = c.get('principal');
  const payee = payeeFor(c.env);
  const r = await createInstapayRequest(c.env, { workspaceId: c.req.param('storeId')!, userId: p.userId, sessionId: p.sessionId, input: body.data, payee });
  if (r.ok) return c.json({ ...r.request, payee: payee! }, 201);
  if (r.reason === 'invalid_amount' || r.reason === 'unknown_package') return apiError(c, 400, 'invalid_request', r.reason);
  if (r.reason === 'session_revoked') return apiError(c, 401, 'unauthorized');
  if (r.reason === 'yearly_queued') return c.json({ error: 'yearly_queued' }, 409);
  if (r.reason === 'too_many_open') return apiError(c, 409, 'invalid_request', r.reason);
  if (r.reason === 'offboarding') return apiError(c, 409, 'invalid_request', 'offboarding_pending'); // OFFBOARD-FREEZE-1
  if (r.reason === 'disabled') return apiError(c, 404, 'not_found');
  return apiError(c, 503, 'unavailable', r.reason); // no payee configured / session check unavailable: nothing was written
});

/** Reads at most MAX_PROOF_BYTES + 1 bytes of the body: a larger upload is refused without buffering all of it. */
async function readCapped(req: Request): Promise<ArrayBuffer | 'too_large'> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PROOF_BYTES) return 'too_large';
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROOF_BYTES) { await reader.cancel().catch(() => undefined); return 'too_large'; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) { out.set(ch, at); at += ch.byteLength; }
  return out.buffer;
}

/** The transfer proof (jpeg / png / webp / pdf, up to 5 MB), sent as the raw request body with its content type. */
instapayRoutes.put('/stores/:storeId/wallet/instapay/:requestId/proof', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!instapayEnabled(c.env)) return apiError(c, 404, 'not_found');
  const bytes = await readCapped(c.req.raw);
  if (bytes === 'too_large') return apiError(c, 413, 'invalid_request', 'too_large');
  const r = await storeProof(c.env, { workspaceId: c.req.param('storeId')!, requestId: c.req.param('requestId')!, sessionId: c.get('principal').sessionId, bytes, contentType: c.req.header('content-type') ?? '' }, Date.now(), afterResponse(c));
  if (r.ok) return c.json(r.request);
  switch (r.reason) {
    case 'not_found': return apiError(c, 404, 'not_found');
    case 'bad_type': return apiError(c, 415, 'invalid_request', r.reason);
    case 'too_large': return apiError(c, 413, 'invalid_request', r.reason);
    case 'empty': return apiError(c, 400, 'invalid_request', r.reason);
    case 'session_revoked': return apiError(c, 401, 'unauthorized');
    case 'unavailable': return apiError(c, 503, 'unavailable', r.reason);
    default: return apiError(c, 409, 'invalid_request', r.reason); // already submitted / expired
  }
});

/** The merchant's own decisions on their own request. Owner only; neither confirms or credits anything (the operator still decides every payment). */
function selfDecided(c: ApiContext, r: SelfDecision) {
  if (r.ok) return c.json(r.request);
  switch (r.reason) {
    case 'not_found': return apiError(c, 404, 'not_found');
    case 'session_revoked': return apiError(c, 401, 'unauthorized');
    case 'unavailable': return apiError(c, 503, 'unavailable', r.reason);
    case 'offboarding': return apiError(c, 409, 'invalid_request', 'offboarding_pending');
    default: return apiError(c, 409, 'invalid_request', r.reason);
  }
}
instapayRoutes.post('/stores/:storeId/wallet/instapay/:requestId/cancel', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!instapayEnabled(c.env)) return apiError(c, 404, 'not_found');
  const p = c.get('principal');
  return selfDecided(c, await cancelInstapay(c.env, { workspaceId: c.req.param('storeId')!, requestId: c.req.param('requestId')!, sessionId: p.sessionId, userId: p.userId }));
});
instapayRoutes.post('/stores/:storeId/wallet/instapay/:requestId/contest', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!instapayEnabled(c.env)) return apiError(c, 404, 'not_found');
  const body = instapayContest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const p = c.get('principal');
  return selfDecided(c, await contestInstapay(c.env, { workspaceId: c.req.param('storeId')!, requestId: c.req.param('requestId')!, sessionId: p.sessionId, userId: p.userId, note: body.data.note }));
});

/** The operator's signed, short-lived proof link. The token is the authorisation; it names one request and expires in minutes. */
export const instapayProofRoutes = new Hono<{ Bindings: Env }>();
instapayProofRoutes.get('/instapay-proof/:token', async (c) => {
  const proof = await readProof(c.env, c.req.param('token'));
  if (!proof) return c.json({ error: 'not_found' }, 404);
  return new Response(proof.body, { headers: { 'content-type': proof.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-disposition': proof.mime === 'application/pdf' ? 'attachment; filename="transfer-proof.pdf"' : 'inline', 'content-security-policy': "default-src 'none'; sandbox" } });
});
