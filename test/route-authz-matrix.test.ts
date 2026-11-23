import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker, { apiRoutes } from '../src/index';
import { DEFAULT_API_LIMITS, configureApiLimits } from '../src/core/api-rate';
import { configureSessionCheck } from '../src/core/identity/session';
import { apiFor, apiKey, storeId as W0, useApiKey } from './helpers/api';
import { mint } from './helpers/issuer';
import { own } from './helpers/workspace';

/**
 * ROUTE-AUTHZ-1: the role every /api/v1/stores/:storeId route requires, written down once and walked against the REAL worker.
 *  - member:   owner, staff and a super admin who is a member
 *  - assistant: owner and staff; a super admin's session is refused (operator_session)
 *  - manager:  owner and a super admin member; staff get 403
 *  - owner:    the owner only; staff AND a super admin member get 403
 * A route missing from this table fails the first test, so a new route cannot ship without a role decision. The second and third tests
 * hold every route to 401 without a token and 403 for a member of ANOTHER store; the last three hold each route to its role.
 */
type Role = 'member' | 'assistant' | 'manager' | 'owner';
const R: Record<string, Role> = {
  // inbox (owner and staff work the inbox)
  'GET /me': 'member', 'GET /conversations': 'member', 'GET /conversations/:conversationId/messages': 'member', 'GET /messages/:messageId/body': 'member',
  'POST /conversations/:conversationId/read': 'member', 'POST /conversations/:conversationId/assign': 'member', 'PUT /conversations/:conversationId/tags': 'member',
  'GET /conversations/:conversationId/notes': 'member', 'POST /conversations/:conversationId/notes': 'member', 'GET /search': 'member',
  'POST /conversations/:conversationId/messages': 'member', 'GET /throttle': 'member', 'GET /media/:messageId': 'member', 'POST /media': 'member',
  'GET /ws': 'member', 'GET /events': 'member',
  // contacts and orders
  'GET /contacts': 'member', 'PUT /contacts/:waId/tags': 'member', 'PATCH /contacts/:waId': 'member', 'GET /contacts/:waId/orders': 'member',
  'POST /contacts/:waId/orders/:orderNumber/cod-outcome': 'member',
  'DELETE /contacts/:waId': 'manager', 'POST /contacts/merge': 'manager', 'GET /contacts/:waId/export': 'owner',
  // templates
  'GET /templates': 'member', 'GET /templates/:name/:language': 'member', 'GET /templates/shared': 'member', 'GET /templates/shared-requests': 'member',
  'POST /templates/check': 'member', 'POST /templates/sync': 'member',
  'POST /templates': 'manager', 'POST /templates/install-defaults': 'manager', 'POST /templates/shared-requests': 'manager',
  'PUT /templates/:name/:language': 'manager', 'DELETE /templates/:name/:language': 'manager',
  // campaigns, segments, imports (owner or staff read; the writes that spend money or cannot be undone are the owner's; stopping is safe, so staff may)
  'GET /campaigns': 'member', 'GET /campaigns/:campaignId': 'member', 'POST /campaigns/:campaignId/pause': 'member', 'POST /campaigns/:campaignId/cancel': 'member',
  'POST /campaigns': 'manager', 'DELETE /campaigns/:campaignId': 'manager', 'POST /campaigns/:campaignId/send': 'manager', 'POST /campaigns/:campaignId/resume': 'manager',
  'GET /segments': 'member', 'GET /segments/:segmentId': 'member', 'GET /segments/:segmentId/preview': 'member', 'POST /segments/preview': 'member',
  'POST /segments': 'manager', 'PUT /segments/:segmentId': 'manager', 'DELETE /segments/:segmentId': 'manager',
  'GET /imports': 'member', 'GET /imports/:importId': 'member', 'GET /imports/:importId/rejects': 'member', 'POST /imports': 'manager',
  // store link, bot, catalog
  // owner assistant over the Store (CHAT-ASSIST-1): best sellers are read by owner and staff, a coupon is the owner's alone (and never an operator's session)
  'GET /store/top-products': 'member', 'GET /store/orders-summary': 'owner', 'POST /store/coupons': 'owner',
  'GET /store-link/settings': 'member', 'GET /store-link/catalog': 'member', 'GET /bot/funnel': 'member',
  'PATCH /store-link/settings': 'manager', 'POST /store-link/settings/preview': 'manager', 'POST /store-link/catalog/provision': 'manager',
  'POST /store-link/catalog/resync': 'manager', 'PUT /store-link/catalog/commerce': 'manager',
  // agent, connectors, retention (WA-SECRETS-1: what writes or tests a merchant's secrets is the owner's alone; a super admin keeps the GET, which never carries a secret)
  'GET /agent': 'manager', 'PUT /agent': 'owner', 'GET /connectors': 'manager', 'PUT /connectors/:connectorId': 'owner', 'DELETE /connectors/:connectorId': 'owner',
  'POST /connectors/:connectorId/test': 'owner', 'GET /retention': 'manager', 'PUT /retention': 'manager',
  // numbers and shared number
  'GET /numbers': 'member', 'POST /numbers/:phoneNumberId/refresh': 'member', 'GET /shared-number': 'member',
  'GET /numbers/signup-config': 'manager', 'POST /numbers/connect': 'manager', 'POST /numbers/notices/:noticeId/dismiss': 'manager',
  'POST /numbers/:phoneNumberId/register': 'manager', 'POST /numbers/:phoneNumberId/disconnect': 'manager',
  'POST /shared-number/join': 'owner', 'POST /shared-number/leave': 'owner',
  // money (staff may see the balance, the plans and the weekly digest; everything that moves or lists money is the owner's)
  'GET /wallet': 'member', 'GET /wallet/estimate': 'member', 'GET /digest': 'member', 'GET /packages': 'member',
  'GET /wallet/statement': 'manager',
  'PUT /digest': 'owner', 'GET /wallet/refund-requests': 'owner', 'POST /wallet/refund-requests': 'owner', 'POST /wallet/topups': 'owner', 'GET /wallet/topups/:orderId': 'owner',
  'GET /wallet/instapay': 'owner', 'POST /wallet/instapay': 'owner', 'PUT /wallet/instapay/:requestId/proof': 'owner',
  'GET /wallet/yearly-refund': 'owner', 'POST /wallet/yearly-refund/preview': 'owner', 'POST /wallet/yearly-refund/requests': 'owner',
  'GET /wallet/credit-packs': 'owner', 'POST /wallet/credit-packs/preview': 'owner', 'POST /wallet/credit-packs/orders': 'owner', 'GET /wallet/credit-packs/orders/:orderId': 'owner',
  'POST /numbers/:phoneNumberId/funding/preview': 'owner', 'PUT /numbers/:phoneNumberId/funding': 'owner',
  'POST /packages/:packageId/checkout': 'owner', 'GET /packages/orders/:orderId': 'owner',
  // team and workspace deletion
  'GET /members': 'owner', 'PUT /members/:userId/seat': 'owner', 'DELETE /members/:userId/seat': 'owner',
  'GET /offboarding': 'manager', 'POST /offboarding': 'owner', 'DELETE /offboarding': 'owner',
  // the assistant acts on the person's own session (a super admin's is refused on the writes; history is a read)
  // later additions, each recorded from the handler's own check (see the PR table): quick replies have NO role check by design (staff keep the team's canned texts)
  'GET /quick-replies': 'member', 'POST /quick-replies': 'member', 'PUT /quick-replies/:quickReplyId': 'member', 'DELETE /quick-replies/:quickReplyId': 'member',
  'GET /campaigns/:campaignId/report': 'manager', 'POST /templates/install-seasonal': 'manager', 'POST /templates/cod-v2/resubmit': 'manager',
  'GET /proactive-recs': 'manager', 'PUT /proactive-recs': 'manager',
  'GET /contacts/consent-evidence': 'owner', 'GET /audit': 'owner',
  // standalone workspaces only (CHAT-SA-4): `storeRole !== 'owner'` is the check, but the id-shape 404 runs first on a Store id (role refusal is covered in standalone-members.test.ts)
  'POST /members/invite': 'owner', 'DELETE /members/:userId': 'owner', 'DELETE /members/invitations/:userId': 'owner',
  'GET /assistant/conversations/:conversationId': 'member',
  'POST /assistant/turn': 'assistant', 'POST /assistant/feedback': 'assistant', 'POST /assistant/previews/:previewId/apply': 'assistant',
  'POST /assistant/applied/:appliedId/undo': 'assistant', 'POST /assistant/approvals/:approvalId/confirm': 'assistant', 'POST /assistant/approvals/:approvalId/reject': 'assistant',
};

/** Owner routes that exist only on a standalone (sw_) workspace: on the Store-linked workspaces this suite walks they answer 404 before any role check. */
const STANDALONE_ONLY = new Set(['POST /members/invite', 'DELETE /members/:userId', 'DELETE /members/invitations/:userId']);
const PREFIX = '/stores/:storeId';
const registered = (): string[] => {
  const seen = new Set<string>();
  for (const r of apiRoutes.routes) if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith(`${PREFIX}/`)) seen.add(`${r.method} ${r.path.slice(PREFIX.length)}`);
  return [...seen].sort();
};
const concrete = (path: string) => path.replace(/:[A-Za-z]+(\{[^}]*\})?/g, '1');

useApiKey();
let prev = DEFAULT_API_LIMITS;
beforeEach(() => {
  prev = configureApiLimits({ workspace: { ratePerSec: 1e6, burst: 1e6 }, integration: { ratePerSec: 1e6, burst: 1e6 } });
  configureSessionCheck(async () => false);
});
afterEach(() => { configureApiLimits(prev); configureSessionCheck(null); });

// Every optional surface on, so a role refusal is what answers (a switched-off surface answers 404 to everyone and would hide a missing check).
const ON = { SHARED_NUMBER_ENABLED: 'true', EMBEDDED_SIGNUP_ENABLED: '1' };
async function hit(token: string | null, ws: string, key: string, headers: Record<string, string> = {}) {
  const [method, path] = key.split(' ') as [string, string];
  const hasBody = method !== 'GET' && method !== 'DELETE';
  // The upload routes take their own body type; the content-type guard (415) runs before the handler's role check, so send the type each one accepts.
  const type = key === 'POST /imports' ? 'multipart/form-data; boundary=x' : key.startsWith('PUT /wallet/instapay/') ? 'image/png' : 'application/json';
  const res = await worker.fetch(new Request(`https://x/api/v1/stores/${ws}${concrete(path)}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(hasBody ? { 'content-type': type } : {}), ...headers }, ...(hasBody ? { body: '{}' } : {}),
  }), { ...env, ...ON } as typeof env, createExecutionContext());
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  return { status: res.status, roleRefused: res.status === 403 && body?.error === 'forbidden' && body.message === undefined, body };
}
const tokenOf = (stores: { id: string; role: 'owner' | 'staff' }[], pa?: string) => mint(apiKey(), { stores, ...(pa ? { pa } : {}) });
const SUPER = 'super_admin';
const W = (n: number) => W0(8600 + n);

describe('ROUTE-AUTZ-1: the role of every store route', () => {
  it('the table names exactly the registered store routes (a new route needs a role decision)', () => {
    expect(registered().filter((k) => !(k in R))).toEqual([]);
    expect(Object.keys(R).filter((k) => !registered().includes(k))).toEqual([]);
    expect(registered().length).toBeGreaterThan(110);
  });

  it('no token: 401 on every route', async () => {
    const bad: string[] = [];
    for (const k of registered()) { const r = await hit(null, W(1), k); if (r.status !== 401) bad.push(`${k} -> ${r.status}`); }
    expect(bad).toEqual([]);
  }, 120_000);

  it('a member of ANOTHER store (owner, staff) is refused on every route: 403, never a read or write of this store', async () => {
    await apiFor(W(2));
    const bad: string[] = [];
    for (const [label, token] of [['owner', await tokenOf([{ id: W(3), role: 'owner' }])], ['staff', await tokenOf([{ id: W(3), role: 'staff' }])]] as const) {
      for (const k of registered()) { const r = await hit(token, W(2), k); if (!r.roleRefused) bad.push(`${label} ${k} -> ${r.status}`); }
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it('staff: refused (403 forbidden) on exactly the manager and owner routes, not on the member and assistant routes', async () => {
    const ws = W(4);
    const staff = (await apiFor(ws, 'staff')).token;
    const bad: string[] = [];
    for (const k of registered()) {
      const r = await hit(staff, ws, k);
      const refused = (R[k] === 'manager' || R[k] === 'owner') && !STANDALONE_ONLY.has(k);
      if (STANDALONE_ONLY.has(k) && r.status !== 404) bad.push(`${k} (standalone only) -> ${r.status}`);
      if (r.roleRefused !== refused) bad.push(`${k} (${R[k]}) -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it('a super admin who is a member: refused on the owner routes and the assistant writes, allowed on the manager and member routes', async () => {
    const ws = W(5);
    await apiFor(ws);
    const op = await tokenOf([{ id: ws, role: 'owner' }], SUPER);
    const bad: string[] = [];
    for (const k of registered()) {
      const r = await hit(op, ws, k);
      if (STANDALONE_ONLY.has(k)) { if (r.status !== 404) bad.push(`${k} (standalone only) -> ${r.status}`); continue; }
      const refused = R[k] === 'owner' || (R[k] === 'assistant' && r.body?.message === 'operator_session');
      const expectRefused = R[k] === 'owner' || R[k] === 'assistant';
      if (expectRefused ? !(refused && r.status === 403) && !(R[k] === 'owner' && r.roleRefused) : r.roleRefused) bad.push(`${k} (${R[k]}) -> ${r.status} ${JSON.stringify(r.body)}`);
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it('the owner is never refused by a role check on any route', async () => {
    const ws = W(6);
    const owner = (await apiFor(ws)).token;
    const bad: string[] = [];
    for (const k of registered()) { const r = await hit(owner, ws, k); if (r.roleRefused || r.status === 401) bad.push(`${k} -> ${r.status} ${JSON.stringify(r.body)}`); }
    expect(bad).toEqual([]);
  }, 180_000);

  it('operator routes: every /operator route is 401 without a token and 403 for an owner, a staff member and not a super admin', async () => {
    const ws = W(7);
    await apiFor(ws);
    const ops = [...new Set(apiRoutes.routes.filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/operator/')).map((r) => `${r.method} ${r.path}`))];
    expect(ops.length).toBeGreaterThan(60);
    const call = async (token: string | null, k: string) => {
      const [method, path] = k.split(' ') as [string, string];
      const hasBody = method !== 'GET' && method !== 'DELETE';
      return (await worker.fetch(new Request(`https://x/api/v1${concrete(path)}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(hasBody ? { 'content-type': 'application/json' } : {}) }, ...(hasBody ? { body: '{}' } : {}) }), { ...env, ...ON } as typeof env, createExecutionContext())).status;
    };
    const bad: string[] = [];
    const owner = await tokenOf([{ id: ws, role: 'owner' }]);
    const staff = await tokenOf([{ id: ws, role: 'staff' }]);
    for (const k of ops) {
      if ((await call(null, k)) !== 401) bad.push(`${k} anonymous`);
      if ((await call(owner, k)) !== 403) bad.push(`${k} owner`);
      if ((await call(staff, k)) !== 403) bad.push(`${k} staff`);
    }
    expect(bad).toEqual([]);
  }, 180_000);

  it('a store route that names another store\'s resource by id finds nothing: the owner of A cannot refresh, disconnect, fund or dismiss B\'s number or notice', async () => {
    const a = W(8);
    const b = W(9);
    await apiFor(a);
    await own(b, '7770001');
    const ownerA = await tokenOf([{ id: a, role: 'owner' }]);
    const results: Record<string, number> = {};
    for (const [method, path, body] of [
      ['POST', '/numbers/7770001/refresh', {}], ['POST', '/numbers/7770001/disconnect', {}], ['POST', '/numbers/7770001/register', {}],
      ['POST', '/numbers/7770001/funding/preview', { funding: 'merchant_card' }], ['POST', '/numbers/notices/1/dismiss', {}],
      ['GET', '/wallet/topups/00000000-0000-4000-8000-000000000001', undefined], ['GET', '/packages/orders/00000000-0000-4000-8000-000000000001', undefined],
    ] as const) {
      const res = await worker.fetch(new Request(`https://x/api/v1/stores/${a}${path}`, { method, headers: { authorization: `Bearer ${ownerA}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), { ...env, ...ON } as typeof env, createExecutionContext());
      results[`${method} ${path}`] = res.status;
    }
    expect(Object.values(results).every((s) => s === 404), JSON.stringify(results)).toBe(true);
    const still = await env.DB.prepare("SELECT status, workspace_id FROM phone_numbers WHERE phone_number_id = '7770001'").first<{ status: string; workspace_id: string }>();
    expect(still).toEqual({ status: 'active', workspace_id: b });
  }, 60_000);
});
