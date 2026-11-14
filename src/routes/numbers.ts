import { Hono } from 'hono';
import { connectNumberRequest, listNumbersResponse, signupConfigDto } from '../core/api/contract';
import { SignupConfigError, connectNumber, disconnectNumber, listNumbers, refreshNumber, resumeSetup, signupEnabled, type NumberResult } from '../core/numbers/numbers';
import { apiError, planRequired, workspaceStub, type ApiContext, type ApiEnv, managesStore } from './shared';
import { alert } from '../core/observability';
import { openNotices, resolveNotice } from '../core/meta/notices';

const owner = managesStore;
const PN = /^[0-9]{1,30}$/;

/** Reply for a connect/refresh/register/disconnect result. A failure that left a number behind still shows its state. */
function reply(c: ApiContext, r: NumberResult): Response {
  if (r.ok) return c.json({ number: r.number, warnings: r.warnings });
  return c.json({ error: r.error, message: r.message, ...(r.number ? { number: r.number } : {}) }, r.status);
}

/** Phase 8.1: a merchant's own WhatsApp number. Every route answers 404 until EMBEDDED_SIGNUP_ENABLED is on. */
export const numbersRoutes = new Hono<ApiEnv>();

numbersRoutes.use('/stores/:storeId/numbers', async (c, next) => (signupEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));
numbersRoutes.use('/stores/:storeId/numbers/*', async (c, next) => (signupEnabled(c.env) ? next() : apiError(c, 404, 'not_found')));

/** Wraps a handler so a missing secret is one loud log line and a clear 503 instead of a crash. */
async function guarded(c: ApiContext, run: (workspaceId: string) => Promise<NumberResult>, needsPlan = false): Promise<Response> {
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  // WA-NOFREE-1: connecting / registering a number (coexistence included) needs a package. Refreshing and disconnecting stay open.
  if (needsPlan) {
    const noPlan = await planRequired(c, ws);
    if (noPlan) return noPlan;
  }
  try {
    return reply(c, await run(c.req.param('storeId')!));
  } catch (err) {
    if (err instanceof SignupConfigError) {
      alert('signup_not_configured', { missing: err.missing });
      return apiError(c, 503, 'signup_unavailable', 'signup_not_configured');
    }
    throw err;
  }
}

/** The request's `waitUntil`, or nothing when there is no execution context (a test calling the app directly). */
function deferrer(c: ApiContext): ((p: Promise<unknown>) => void) | undefined {
  try { const ctx = c.executionCtx; return (p) => ctx.waitUntil(p); } catch { return undefined; }
}

numbersRoutes.get('/stores/:storeId/numbers', async (c) => {
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  const body: typeof listNumbersResponse._output = { items: await listNumbers(c.env, c.req.param('storeId')!), notices: owner(c) ? await openNotices(c.env, c.req.param('storeId')!) : [] };
  return c.json(body);
});

/** The owner has read a notice and keeps the numbers connected. (Disconnecting a number settles its notices by itself.) */
numbersRoutes.post('/stores/:storeId/numbers/notices/:noticeId/dismiss', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const id = Number(c.req.param('noticeId'));
  if (!Number.isInteger(id) || id < 1) return apiError(c, 400, 'invalid_request');
  const ok = await resolveNotice(c.env, c.req.param('storeId')!, id, c.get('principal').userId);
  return ok ? c.json({ ok: true }) : apiError(c, 404, 'not_found');
});

/** The public Meta ids the page needs to open Embedded Signup (v4+: the configuration decides the flow). Not secrets, but owner-only like connect. */
numbersRoutes.get('/stores/:storeId/numbers/signup-config', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  if (!(await workspaceStub(c))) return apiError(c, 404, 'not_found');
  if (!c.env.META_APP_ID || !c.env.EMBEDDED_SIGNUP_CONFIG_ID) {
    alert('signup_not_configured', { missing: [!c.env.META_APP_ID && 'META_APP_ID', !c.env.EMBEDDED_SIGNUP_CONFIG_ID && 'EMBEDDED_SIGNUP_CONFIG_ID'].filter(Boolean) });
    return apiError(c, 503, 'signup_unavailable', 'signup_not_configured');
  }
  const body: typeof signupConfigDto._output = { appId: c.env.META_APP_ID, configId: c.env.EMBEDDED_SIGNUP_CONFIG_ID, graphVersion: c.env.META_GRAPH_VERSION };
  return c.json(body);
});

numbersRoutes.post('/stores/:storeId/numbers/connect', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = connectNumberRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  return guarded(c, (workspaceId) => connectNumber(c.env, workspaceId, body.data, deferrer(c)), true);
});

numbersRoutes.post('/stores/:storeId/numbers/:phoneNumberId/refresh', async (c) => {
  const pn = c.req.param('phoneNumberId');
  if (!PN.test(pn)) return apiError(c, 400, 'invalid_request');
  return guarded(c, (workspaceId) => refreshNumber(c.env, workspaceId, pn));
});

numbersRoutes.post('/stores/:storeId/numbers/:phoneNumberId/register', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const pn = c.req.param('phoneNumberId');
  if (!PN.test(pn)) return apiError(c, 400, 'invalid_request');
  return guarded(c, (workspaceId) => resumeSetup(c.env, workspaceId, pn, deferrer(c)), true);
});

numbersRoutes.post('/stores/:storeId/numbers/:phoneNumberId/disconnect', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const pn = c.req.param('phoneNumberId');
  if (!PN.test(pn)) return apiError(c, 400, 'invalid_request');
  return guarded(c, (workspaceId) => disconnectNumber(c.env, workspaceId, pn));
});
