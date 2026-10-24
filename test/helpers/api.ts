import { SELF, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';
import { stubGraph, type GraphReply, type GraphCall } from './graph';
import { mint, newKey, type TestKey } from './issuer';
import { seedNumber } from './workspace';

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
export const graphStub = (responder?: (call: GraphCall, n: number) => GraphReply) => stubGraph(responder, { jwks: [key.jwk] });
export const jwks = () => [key.jwk];

/** A registered workspace with an active number, and a fetcher for its /api/v1/stores/:id routes. */
export async function apiFor(storeId: string, role: 'owner' | 'staff' = 'owner', phoneNumberId = `pn-${storeId}`) {
  await seedNumber(phoneNumberId, storeId).catch(() => {}); // already seeded on a second call
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
