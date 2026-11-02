import { createExecutionContext, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import worker from '../src/index';
import { BUYER_KEY_PROBE_INPUT, MIN_PROBE_SECRET_LENGTH, buyerKeyProbe } from '../src/core/buyer-key';
import { isE164, normaliseE164 } from '../src/core/phone';
// @ts-expect-error plain .mjs script, no types
import { runChecks } from '../scripts/verify-prod.mjs';
import probe from '../vectors/buyer-key-probe.json';

// D4: SUITE_BUYER_KEY_SECRET must be the same value on this Worker and on Ebda Store. A secret that differs silently splits every customer into
// two identities. Each Worker publishes a DERIVED test vector (the buyer key of one fixed probe number) on /health; verify-prod compares the two.
// The secret itself never leaves a Worker and is never an input of the check.
const SECRET = 's'.repeat(MIN_PROBE_SECRET_LENGTH);
const health = async (over: Record<string, unknown>) => {
  const res = await (worker as unknown as ExportedHandler<typeof env>).fetch!(new Request('https://x/health'), { ...env, ...over } as typeof env, createExecutionContext());
  return { status: res.status, text: await res.text() };
};

it('the probe input is the exact pinned string and can never be read as a phone number', () => {
  expect(BUYER_KEY_PROBE_INPUT).toBe('suite-buyer-key-probe:v1');
  expect(normaliseE164(BUYER_KEY_PROBE_INPUT)).toBeNull();
  expect(isE164(BUYER_KEY_PROBE_INPUT)).toBe(false);
});

it('/health publishes 16 hex derived from the probe string, never the secret and nothing derived from a phone number', async () => {
  const r = await health({ SUITE_BUYER_KEY_SECRET: SECRET });
  expect(r.status).toBe(200);
  const v = JSON.parse(r.text).buyerKeyVector as string;
  expect(v).toMatch(/^[0-9a-f]{16}$/);
  expect(v).toBe(await buyerKeyProbe(SECRET));
  expect(r.text).not.toContain(SECRET);
  expect(r.text).not.toMatch(/[0-9a-f]{32,}/); // no full buyer-key-sized value anywhere in the public body
});

it('pinned vector: HMAC-SHA256(secret, "suite-buyer-key-probe:v1") as hex, first 16 characters', async () => {
  const { createHmac } = await import('node:crypto');
  expect(await buyerKeyProbe(SECRET)).toBe(createHmac('sha256', SECRET).update('suite-buyer-key-probe:v1').digest('hex').slice(0, 16));
});

it('two Workers with the same secret agree and different secrets differ', async () => {
  expect(await buyerKeyProbe(SECRET)).toBe(await buyerKeyProbe(SECRET));
  expect(await buyerKeyProbe(SECRET)).not.toBe(await buyerKeyProbe('t'.repeat(MIN_PROBE_SECRET_LENGTH)));
  expect(JSON.parse((await health({ SUITE_BUYER_KEY_SECRET: SECRET })).text).buyerKeyVector).toBe(JSON.parse((await health({ SUITE_BUYER_KEY_SECRET: SECRET })).text).buyerKeyVector);
});

it('the vector is published only for a long secret (an offline-guessing oracle on a short one): 63 characters publish nothing, 64 publish 16 hex, unset publishes nothing', async () => {
  expect(MIN_PROBE_SECRET_LENGTH).toBe(64);
  expect('buyerKeyVector' in JSON.parse((await health({ SUITE_BUYER_KEY_SECRET: 's'.repeat(63) })).text)).toBe(false);
  expect(JSON.parse((await health({ SUITE_BUYER_KEY_SECRET: 's'.repeat(64) })).text).buyerKeyVector).toMatch(/^[0-9a-f]{16}$/);
  expect('buyerKeyVector' in JSON.parse((await health({ SUITE_BUYER_KEY_SECRET: undefined })).text)).toBe(false);
});

// The Store's probe vector, vendored byte for byte (vectors/buyer-key-probe.json; sha pinned in test/vendored-artifacts.test.ts): same secret,
// same message, so both Workers prove the same derivation, not just "both use HMAC".
it("the Store's published probe vector: same secret, same message, same 16 hex", async () => {
  expect(probe.secret.length).toBeGreaterThanOrEqual(64);
  expect(BUYER_KEY_PROBE_INPUT).toBe(probe.message);
  expect(await buyerKeyProbe(probe.secret)).toBe(probe.vector);
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
const V = 'a'.repeat(16);

it('verify-prod passes when both Workers publish the same vector', async () => {
  expect(await check({ buyerKeyVector: V }, { buyerKeyVector: V })).toMatchObject({ ok: true });
});
it('verify-prod FAILS when the vectors differ, and says what that means', async () => {
  const c = await check({ buyerKeyVector: V }, { buyerKeyVector: 'b'.repeat(16) });
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
