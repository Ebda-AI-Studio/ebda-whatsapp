import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { clearTokenCaches, graphTokenFor, invalidateWaba, TokenUnavailable } from '../src/core/numbers/token';
import type { SendJob } from '../src/core/send-queue';
import { stubGraph } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';
import { consume } from './helpers/queue';
import { seedNumber } from './helpers/workspace';

let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(clearTokenCaches);
afterEach(() => graph?.restore());

const job = (ws: string, pn: string, key: string): SendJob => ({ workspaceId: ws, phoneNumberId: pn, to: '201001234567', text: 'hi', idempotencyKey: key });

it('an own-number send uses the business token; a platform number uses the platform token', async () => {
  await seedOwnNumber('pn-own-1', 'ws-tok-1', 'waba-own-1', 'biz-token-1');
  await seedNumber('pn-plat-1', 'ws-tok-2'); // seedNumber / seedOwnNumber both put the workspace on a package
  graph = stubGraph();
  await consume([job('ws-tok-1', 'pn-own-1', 'reply:own')]);
  await consume([job('ws-tok-2', 'pn-plat-1', 'reply:plat')]);
  expect(graph.calls.map((c) => c.headers.authorization)).toEqual(['Bearer biz-token-1', 'Bearer test-token']);
});

it('resolves by WABA as well, and an unknown number falls back to the platform token', async () => {
  await seedOwnNumber('pn-own-2', 'ws-tok-3', 'waba-own-2', 'biz-token-2');
  expect(await graphTokenFor(env, { wabaId: 'waba-own-2' })).toBe('biz-token-2');
  expect(await graphTokenFor(env, { phoneNumberId: 'pn-own-2' })).toBe('biz-token-2');
  expect(await graphTokenFor(env, { wabaId: 'waba-unknown' })).toBe('test-token');
  expect(await graphTokenFor(env, { phoneNumberId: 'pn-unknown' })).toBe('test-token');
});

it('an own number whose credential is gone never falls back to the platform token', async () => {
  await seedOwnNumber('pn-own-3', 'ws-tok-4', 'waba-own-3');
  await env.DB.prepare('DELETE FROM waba_credentials WHERE waba_id = ?').bind('waba-own-3').run();
  clearTokenCaches();
  await expect(graphTokenFor(env, { phoneNumberId: 'pn-own-3' })).rejects.toBeInstanceOf(TokenUnavailable);
  graph = stubGraph();
  const res = await consume([job('ws-tok-4', 'pn-own-3', 'reply:nocred')]);
  expect(graph.calls).toHaveLength(0);
  expect(res.explicitAcks).toEqual(['m0']);
});

it('caches the token per WABA for the isolate and drops the entry on invalidation', async () => {
  await seedOwnNumber('pn-own-4', 'ws-tok-5', 'waba-own-4', 'biz-token-4');
  expect(await graphTokenFor(env, { wabaId: 'waba-own-4' })).toBe('biz-token-4');
  await env.DB.prepare('DELETE FROM waba_credentials WHERE waba_id = ?').bind('waba-own-4').run();
  expect(await graphTokenFor(env, { wabaId: 'waba-own-4' })).toBe('biz-token-4'); // served from the cache
  invalidateWaba('waba-own-4');
  expect(await graphTokenFor(env, { wabaId: 'waba-own-4' })).toBe('test-token'); // entry gone: re-read, no credential
});
