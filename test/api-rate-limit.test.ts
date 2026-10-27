import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { DEFAULT_API_LIMITS, configureApiLimits } from '../src/core/api-rate';
import { apiFor, apiKey, storeId as W, useApiKey } from './helpers/api';
import { mintClient } from './helpers/issuer';

// F4: per-workspace and per-integrator-token API rate limits.
useApiKey();
let restore: () => void = () => undefined;
afterEach(() => restore());
beforeEach(() => { restore = () => undefined; });
const limit = (l: Parameters<typeof configureApiLimits>[0]) => { const prev = configureApiLimits(l); restore = () => void configureApiLimits(prev); };
const SLOW = 0.0001; // refill is negligible inside a test

describe('per-workspace limit', () => {
  it('answers 429 rate_limited with Retry-After past the burst; another workspace is unaffected', async () => {
    limit({ workspace: { ratePerSec: SLOW, burst: 3 }, integration: DEFAULT_API_LIMITS.integration });
    const a = await apiFor(W(8001));
    const b = await apiFor(W(8002));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await a.call('GET', '/me')).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await a.call('GET', '/me');
    expect(await r.json()).toEqual({ error: 'rate_limited' });
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await b.call('GET', '/me')).status).toBe(200);
  });
  it('a request refused for a bad token does not spend the workspace allowance', async () => {
    limit({ workspace: { ratePerSec: SLOW, burst: 2 }, integration: DEFAULT_API_LIMITS.integration });
    const a = await apiFor(W(8003));
    for (let i = 0; i < 5; i++) expect((await fetch(`https://x/api/v1/stores/${W(8003)}/me`, { headers: { authorization: 'Bearer nope' } }).catch(() => ({ status: 401 }))).status).toBe(401);
    expect((await a.call('GET', '/me')).status).toBe(200);
  });
});

describe('per-integrator-token limit', () => {
  const live = { INTEGRATOR_TOKENS_ENABLED: 'true', ACCOUNTS: { isRevoked: async () => false } };
  const call = async (token: string, path: string) =>
    worker.fetch(new Request(`https://x/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } }), { ...env, ...live } as typeof env, createExecutionContext());
  it('one client is cut off at its own burst while the workspace (and a second client) keeps working', async () => {
    limit({ workspace: { ratePerSec: 1000, burst: 1000 }, integration: { ratePerSec: SLOW, burst: 2 } });
    const STORE = W(8004);
    await apiFor(STORE);
    const t1 = await mintClient(apiKey(), { storeId: STORE, clientId: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA', scope: 'conversations:read' });
    const t1b = await mintClient(apiKey(), { storeId: STORE, clientId: 'cli_AAAAAAAAAAAAAAAAAAAAAAAAAA', scope: 'conversations:read' }); // a re-minted token of the SAME client
    const t2 = await mintClient(apiKey(), { storeId: STORE, clientId: 'cli_BBBBBBBBBBBBBBBBBBBBBBBBBB', scope: 'conversations:read' });
    const path = `/stores/${STORE}/conversations`;
    expect((await call(t1, path)).status).toBe(200);
    expect((await call(t1b, path)).status).toBe(200);
    expect((await call(t1, path)).status).toBe(429);
    expect((await call(t2, path)).status).toBe(200);
  });
});
