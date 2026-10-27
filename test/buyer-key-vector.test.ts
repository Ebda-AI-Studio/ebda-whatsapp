import { createExecutionContext, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src/index';
import { BUYER_KEY_PROBE_E164, buyerKey } from '../src/core/buyer-key';
// @ts-expect-error plain .mjs script, no types
import { runChecks } from '../scripts/verify-prod.mjs';

// D4: SUITE_BUYER_KEY_SECRET must be the same value on this Worker and on Ebda Store. A secret that differs silently splits every customer into
// two identities. Each Worker publishes a DERIVED test vector (the buyer key of one fixed probe number) on /health; verify-prod compares the two.
// The secret itself never leaves a Worker and is never an input of the check.
const SECRET = 's'.repeat(32);
const health = async (over: Record<string, unknown>) => {
  const res = await (worker as unknown as ExportedHandler<typeof env>).fetch!(new Request('https://x/health'), { ...env, ...over } as typeof env, createExecutionContext());
  return { status: res.status, text: await res.text() };
};

it('/health publishes the buyer key of the probe number, never the secret', async () => {
  const r = await health({ SUITE_BUYER_KEY_SECRET: SECRET });
  expect(r.status).toBe(200);
  expect(JSON.parse(r.text).buyerKeyVector).toBe(await buyerKey(SECRET, BUYER_KEY_PROBE_E164));
  expect(r.text).not.toContain(SECRET);
});

it('without the secret there is no vector (and no empty string that two unset Workers would "agree" on)', async () => {
  const r = await health({ SUITE_BUYER_KEY_SECRET: undefined });
  expect('buyerKeyVector' in JSON.parse(r.text)).toBe(false);
});

const fake = (self: Record<string, unknown>, peer?: Record<string, unknown> | 'down') => async (url: string) => {
  const u = new URL(url);
  if (u.host === 'peer.test') return peer === 'down' ? new Response('nope', { status: 503 }) : new Response(JSON.stringify(peer ?? {}));
  if (u.pathname === '/health') return new Response(JSON.stringify({ ok: true, service: 'ebda-wa', commit: 'abc', ...self }), { headers: { 'strict-transport-security': 'max-age=1', 'x-content-type-options': 'nosniff' } });
  return new Response('nf', { status: 404 });
};
const check = async (self: Record<string, unknown>, peer?: Record<string, unknown> | 'down', peerHealth: string | undefined = 'https://peer.test/health') =>
  (await runChecks({ base: 'https://wa.test', peerHealth, fetchImpl: fake(self, peer) })).find((c: { name: string }) => c.name === 'suite buyer key equal on both Workers');
const V = 'a'.repeat(64);

it('verify-prod passes when both Workers publish the same vector', async () => {
  expect(await check({ buyerKeyVector: V }, { buyerKeyVector: V })).toMatchObject({ ok: true });
});
it('verify-prod FAILS when the vectors differ, and says what that means', async () => {
  const c = await check({ buyerKeyVector: V }, { buyerKeyVector: 'b'.repeat(64) });
  expect(c).toMatchObject({ ok: false });
  expect(c.detail).toMatch(/different/i);
  expect(c.detail).not.toContain(V);
});
it('verify-prod FAILS when this Worker publishes none (secret unset), even if the peer has one', async () => {
  expect(await check({}, { buyerKeyVector: V })).toMatchObject({ ok: false });
});
it('verify-prod is SKIPPED (never passed) with no peer given, or when the peer does not publish a vector yet or is down', async () => {
  expect(await check({ buyerKeyVector: V }, undefined, undefined)).toMatchObject({ ok: null });
  expect(await check({ buyerKeyVector: V }, {})).toMatchObject({ ok: null });
  expect(await check({ buyerKeyVector: V }, 'down')).toMatchObject({ ok: null });
});
it('two Workers that both publish nothing never count as equal', async () => {
  expect(await check({}, {})).not.toMatchObject({ ok: true });
});
