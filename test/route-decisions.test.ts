// @repo-guard
import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRoutes } from '../src/index';
import { allowedWhileSuspended } from '../src/core/identity/middleware';
import { configureSessionCheck } from '../src/core/identity/session';
import { ROUTE_SCOPES, SESSION_CHECKED_READS, SESSION_UNCHECKED_READS, gateForRoute } from '../src/core/identity/scopes';
import { OP1, apiFor, operatorCall, storeId as W, useApiKey } from './helpers/api';
import { openChat, own } from './helpers/workspace';

useApiKey();
afterEach(() => configureSessionCheck(null));
const A = '201001234567';
const REASON = 'abuse report 2026-10-27';

describe('decisions are made on the ROUTED pattern, never on the raw URL', () => {
  it('a revoked owner session cannot export through an encoded path (/expor%74), and a trailing slash is not a way in either', async () => {
    const ws = W(4301);
    await own(ws);
    await openChat(ws, A);
    const owner = await apiFor(ws);
    configureSessionCheck(async () => true);
    for (const path of [`/contacts/${A}/export`, `/contacts/${A}/expor%74`, `/contacts/${A}/exp%6frt`, `/contacts/%32${A.slice(1)}/export`]) {
      const r = await owner.call('GET', path);
      expect(r.status, path).toBe(403);
      expect(await r.json(), path).toMatchObject({ message: 'session_revoked' });
    }
    const slash = await owner.call('GET', `/contacts/${A}/export/`);
    expect([403, 404]).toContain(slash.status); // never a 200 with the data
    configureSessionCheck(async () => false);
    expect((await owner.call('GET', `/contacts/${A}/expor%74`)).status).toBe(200); // the same variant works for a healthy session: it IS the export route
  });

  it('a suspended store: an encoded variant of a blocked route is refused, an encoded variant of an allowed route is allowed (same decision as the plain path)', async () => {
    const ws = W(4302);
    await own(ws);
    const owner = await apiFor(ws);
    configureSessionCheck(async () => false);
    expect((await operatorCall(OP1, 'POST', `/workspaces/${ws}/suspend`, { reason: REASON })).status).toBe(200);
    for (const path of ['/campaigns', '/camp%61igns']) {
      const r = await owner.call('POST', path, {});
      expect(r.status, path).toBe(403);
      expect(await r.json(), path).toMatchObject({ message: 'workspace_suspended' });
    }
    for (const path of ['/wallet/topups', '/wall%65t/topups']) {
      const r = await owner.call('POST', path, { amountMinor: 20000 });
      expect(await r.clone().json().catch(() => ({})), path).not.toMatchObject({ message: 'workspace_suspended' });
    }
    void SELF; void env;
  });

  it('the suspension allow-list is by route pattern', () => {
    expect(allowedWhileSuspended('POST', '/stores/:storeId/wallet/topups')).toBe(true);
    expect(allowedWhileSuspended('POST', '/stores/:storeId/packages/:packageId/checkout')).toBe(true);
    expect(allowedWhileSuspended('DELETE', '/stores/:storeId/contacts/:waId')).toBe(true);
    expect(allowedWhileSuspended('POST', '/stores/:storeId/campaigns')).toBe(false);
    expect(allowedWhileSuspended('POST', '/stores/:storeId/walletx')).toBe(false);
    expect(allowedWhileSuspended('GET', '/stores/:storeId/contacts/:waId')).toBe(false);
  });

  it('an integration scope is decided on the pattern too', () => {
    expect(gateForRoute('GET', '/stores/:storeId/conversations')).toBe('conversations:read');
    expect(gateForRoute('GET', '/stores/:storeId/contacts/:waId/export')).toBe('person_only');
    expect(gateForRoute('GET', '/stores/:storeId/*')).toBeNull(); // an unmatched path has no decision: default deny
    expect(gateForRoute('HEAD', '/stores/:storeId/conversations')).toBe('conversations:read');
  });
});

describe('every store read has a session decision', () => {
  const real = (apiRoutes.routes as { method: string; path: string }[]).filter((r) => r.method === 'GET' && r.path.startsWith('/stores/:storeId/')).map((r) => `GET ${r.path}`);

  it('is either checked like a write or explicitly listed as unchecked, with a reason: a new read needs a decision', () => {
    const decided = new Set([...SESSION_CHECKED_READS, ...Object.keys(SESSION_UNCHECKED_READS)]);
    expect(real.filter((r) => !decided.has(r)), 'store reads with no session decision (src/core/identity/scopes.ts)').toEqual([]);
    expect([...decided].filter((r) => !real.includes(r)), 'decisions for routes that do not exist').toEqual([]);
    for (const [k, why] of Object.entries(SESSION_UNCHECKED_READS)) expect(why.length, k).toBeGreaterThan(15);
    for (const k of SESSION_CHECKED_READS) expect(k in ROUTE_SCOPES, k).toBe(true);
  });
});
