import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';

afterEach(() => vi.restoreAllMocks());
const B64_32 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const HEX_32 = 'ab'.repeat(32); // what `openssl rand -hex 32` prints: decodes to 48 bytes as base64
const health = async (over: Record<string, unknown>) => {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
  const res = await (worker as unknown as ExportedHandler<typeof env>).fetch!(new Request('https://x/health'), { ...env, ...over } as typeof env, createExecutionContext());
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, errors: errors.join('\n') };
};

it('a key that is set but malformed fails /health with 503, names the key only in the alert line, never in the public body', async () => {
  for (const key of ['TOKEN_ENC_KEY', 'AGENT_SECRETS_KEY']) {
    const r = await health({ [key]: HEX_32 });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ ok: false, status: 'misconfigured' });
    expect(JSON.stringify(r.body)).not.toContain(key);
    expect(r.errors).toContain('secret_misconfigured');
    expect(r.errors).toContain(key);
    expect(r.errors).not.toContain(HEX_32); // never the value
  }
  expect((await health({ PROOF_URL_SECRET: 'short' })).status).toBe(503); // under 32 characters
});

it('a key listed in REQUIRED_SECRETS but not set fails /health; well-formed keys pass', async () => {
  const required = 'TOKEN_ENC_KEY,AGENT_SECRETS_KEY,PROOF_URL_SECRET,SUITE_BUYER_KEY_SECRET';
  const good = { TOKEN_ENC_KEY: B64_32, AGENT_SECRETS_KEY: B64_32, PROOF_URL_SECRET: 'p'.repeat(64), SUITE_BUYER_KEY_SECRET: 's'.repeat(32) };
  const missing = await health({ REQUIRED_SECRETS: required, ...good, PROOF_URL_SECRET: undefined });
  expect(missing.status).toBe(503);
  expect(missing.errors).toContain('PROOF_URL_SECRET');
  const ok = await health({ REQUIRED_SECRETS: required, ...good });
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ ok: true, status: 'ok' });
  expect((await health({ TOKEN_ENC_KEY: B64_32.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_') })).status).toBe(200); // base64url is accepted
});

it('Ruling WA-VECTORIZE-1: a missing VECTORIZE binding fails /health with 503 naming the binding in the alert line only; the live binding passes', async () => {
  const bad = await health({ VECTORIZE: undefined });
  expect(bad.status).toBe(503);
  expect(bad.body).toMatchObject({ ok: false, status: 'misconfigured' });
  expect(JSON.stringify(bad.body)).not.toContain('VECTORIZE');
  expect(bad.errors).toContain('binding_missing');
  expect(bad.errors).toContain('VECTORIZE');
  const ok = await health({});
  expect(ok.status).toBe(200);
});
