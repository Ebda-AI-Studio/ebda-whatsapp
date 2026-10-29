import { SELF, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import { stubGraph, type GraphReply, type GraphCall } from './graph';
import { mint, newKey, type TestKey } from './issuer';
import { exec, seedNumber } from './workspace';

let key: TestKey;
/** Call once per test file: creates the signing key route tests mint tokens with. `jwks()` feeds stubGraph. */
export function useApiKey() {
  beforeAll(async () => {
    key = await newKey('kapi');
  });
  // Route tests need the identity JWKS answered; Graph calls get the default success reply unless a test re-stubs.
  beforeEach(() => {
    stubGraph(undefined, { jwks: [key.jwk] });
  });
}
/** Re-stubs Graph with a custom responder while keeping the JWKS answer. */
export const graphStub = (responder?: (call: GraphCall, n: number) => GraphReply, delayMs?: number, before?: (call: GraphCall) => Promise<void> | void) =>
  stubGraph(responder, { jwks: [key.jwk], ...(delayMs ? { delayMs } : {}), ...(before ? { before } : {}) });
export const jwks = () => [key.jwk];
/** The signing key `useApiKey` created (for tests that mint other kinds of token). */
export const apiKey = (): TestKey => key;

/** A registered workspace with an active number, and a fetcher for its /api/v1/stores/:id routes. */
export async function apiFor(storeId: string, role: 'owner' | 'staff' = 'owner', phoneNumberId = `pn-${storeId}`) {
  await seedNumber(phoneNumberId, storeId); // already seeded on a second call
  // A staff fixture is a SEATED staff member (WA-SEATS-1: the owner assigned the seat); it only matters when the Store link is on. test/seats.test.ts covers the unseated case.
  if (role === 'staff') await exec(storeId, "INSERT OR IGNORE INTO seats (user_id, assigned_at, assigned_by) VALUES ('6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f', 0, 'fixture')");
  const token = await mint(key, { stores: [{ id: storeId, role }] });
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    SELF.fetch(`https://x/api/v1/stores/${storeId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...extra },
      ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
    });
  return { call, token, phoneNumberId, env };
}

/** Route tests need UUID store ids (identity contract v1). Distinct n per test keeps their DOs separate. */
export const storeId = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

/** A token for `storeId` that expires `expSeconds` from now (negative = already expired, still inside the verifier's skew tolerance). */
export const tokenFor = (storeId: string, expSeconds: number, role: 'owner' | 'staff' = 'owner') => mint(key, { stores: [{ id: storeId, role }] }, { expSeconds });

/** A bearer token for a super admin (identity claim `pa: super_admin`); `sub` tells two operators apart. */
export const adminToken = (sub = '11111111-1111-4111-8111-111111111111') => mint(key, { sub, pa: 'super_admin', stores: [] });
export async function operatorCall(sub: string | null, method: string, path: string, body?: unknown) {
  const token = sub === null ? null : await adminToken(sub);
  return SELF.fetch(`https://x/api/v1/operator${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
export const OP1 = '11111111-1111-4111-8111-111111111111';
export const OP2 = '22222222-2222-4222-8222-222222222222';
