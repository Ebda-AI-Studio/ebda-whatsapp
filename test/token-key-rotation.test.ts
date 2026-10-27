import { createExecutionContext, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/core/ai/secrets';
import { rotationStatus, rotateTokenKey } from '../src/core/enc-rotation';
import { clearTokenCaches, graphTokenFor, TokenUnavailable } from '../src/core/numbers/token';
import { signProofLink } from '../src/core/billing/instapay';
import { secretProblems } from '../src/core/secrets-check';
import worker from '../src/index';
import { OP1, operatorCall, useApiKey } from './helpers/api';
import { seedOwnNumber } from './helpers/own-number';

// M-173: TOKEN_ENC_KEY rotation with a dual-key read. New writes use TOKEN_ENC_KEY; reads also accept TOKEN_ENC_KEY_PREVIOUS until
// every row has been re-encrypted (operator route), then the old key is removed.
useApiKey();
const key = (n: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(n)));
const OLD = key(11);
const NEW = key(22);
const at = (e: Record<string, unknown>) => ({ ...env, ...e }) as typeof env;
const cred = (waba: string) => env.DB.prepare('SELECT token_enc FROM waba_credentials WHERE waba_id = ?').bind(waba).first<{ token_enc: string }>().then((r) => r!.token_enc);
beforeEach(clearTokenCaches);

/** A credential written while OLD was the key. */
async function seedOnOld(pn: string, ws: string, waba: string, token: string) {
  await seedOwnNumber(pn, ws, waba, token);
  await env.DB.prepare('UPDATE waba_credentials SET token_enc = ? WHERE waba_id = ?').bind(await encryptSecret(token, OLD, ws), waba).run();
  clearTokenCaches();
}

describe('dual-key read', () => {
  it('a credential encrypted under the old key opens while the old key is listed as previous', async () => {
    await seedOnOld('pn-r1', 'ws-r1', 'waba-r1', 'tok-r1');
    expect(await graphTokenFor(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD }), { wabaId: 'waba-r1' })).toBe('tok-r1');
  });
  it('without the previous key it is unreadable and NEVER falls back to the platform token', async () => {
    await seedOnOld('pn-r2', 'ws-r2', 'waba-r2', 'tok-r2');
    await expect(graphTokenFor(at({ TOKEN_ENC_KEY: NEW }), { phoneNumberId: 'pn-r2' })).rejects.toBeInstanceOf(TokenUnavailable);
  });
  it('a read that needed the previous key re-encrypts the row under the current key (lazy rotation)', async () => {
    await seedOnOld('pn-r3', 'ws-r3', 'waba-r3', 'tok-r3');
    await graphTokenFor(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD }), { wabaId: 'waba-r3' });
    expect(await decryptSecret(await cred('waba-r3'), NEW, 'ws-r3')).toBe('tok-r3');
    clearTokenCaches();
    expect(await graphTokenFor(at({ TOKEN_ENC_KEY: NEW }), { wabaId: 'waba-r3' })).toBe('tok-r3'); // the old key can be dropped now
  });
  it('the workspace id stays bound: a ciphertext moved to another workspace opens under neither key', async () => {
    await seedOnOld('pn-r4', 'ws-r4', 'waba-r4', 'tok-r4');
    await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('ws-other', 'other', 1)").run();
    await env.DB.prepare("UPDATE waba_credentials SET workspace_id = 'ws-other' WHERE waba_id = 'waba-r4'").run();
    await expect(graphTokenFor(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD }), { wabaId: 'waba-r4' })).rejects.toBeInstanceOf(TokenUnavailable);
    await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id = 'waba-r4'").run(); // the tests share one D1: leave no unreadable row behind
  });
  it('an instapay proof link signed under the old key still verifies; new links are signed under the new key', async () => {
    const old = await signProofLink(at({ TOKEN_ENC_KEY: OLD }), '11111111-1111-4111-8111-111111111111');
    const fresh = await signProofLink(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD }), '11111111-1111-4111-8111-111111111111');
    expect(fresh!.url).not.toBe(old!.url);
    const { verifyProofLinkSignature } = await import('../src/core/billing/instapay');
    const token = (u: string) => u.split('/').pop()!;
    expect(await verifyProofLinkSignature(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD }), token(old!.url))).toBe(true);
    expect(await verifyProofLinkSignature(at({ TOKEN_ENC_KEY: NEW }), token(old!.url))).toBe(false);
    expect(await verifyProofLinkSignature(at({ TOKEN_ENC_KEY: NEW }), token(fresh!.url))).toBe(true);
  });
  it('/health refuses a malformed previous key like any other key', () => {
    expect(secretProblems({ TOKEN_ENC_KEY_PREVIOUS: 'short' })).toEqual(['TOKEN_ENC_KEY_PREVIOUS']);
    expect(secretProblems({ TOKEN_ENC_KEY_PREVIOUS: OLD })).toEqual([]);
  });
});

describe('the operator finishes the rotation', () => {
  it('status counts rows still on the previous key; rotate re-encrypts them in batches and is idempotent', async () => {
    await seedOnOld('pn-r5', 'ws-r5', 'waba-r5', 'tok-r5');
    await seedOnOld('pn-r6', 'ws-r6', 'waba-r6', 'tok-r6');
    await env.DB.prepare('UPDATE phone_numbers SET pin_enc = ? WHERE phone_number_id = ?').bind(await encryptSecret('123456', OLD, 'ws-r5'), 'pn-r5').run();
    const e = at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD });
    const before = await rotationStatus(e);
    expect(before.onPrevious).toBeGreaterThanOrEqual(3); // two tokens and one PIN of this test (other tests' rows may add)
    expect(before.unreadable).toBe(0);
    const first = await rotateTokenKey(e, 1); // a batch of one row
    expect(first).toMatchObject({ ok: true, rotated: 1 });
    let guard = 0;
    while ((await rotationStatus(e)).onPrevious > 0 && guard++ < 50) await rotateTokenKey(e, 50);
    expect(await rotationStatus(e)).toMatchObject({ onPrevious: 0, unreadable: 0, complete: true });
    expect(await rotateTokenKey(e, 50)).toMatchObject({ ok: true, rotated: 0 });
    // with the old key gone everything still opens
    clearTokenCaches();
    expect(await graphTokenFor(at({ TOKEN_ENC_KEY: NEW }), { wabaId: 'waba-r6' })).toBe('tok-r6');
    expect(await decryptSecret((await env.DB.prepare('SELECT pin_enc FROM phone_numbers WHERE phone_number_id = ?').bind('pn-r5').first<{ pin_enc: string }>())!.pin_enc, NEW, 'ws-r5')).toBe('123456');
  });
  it('M-173 follow-up: 5,001 credential rows with the LAST one on the old key are NOT complete; after the re-encrypt pass they are', async () => {
    const ws = 'ws-bigrot';
    await env.DB.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, 1)').bind(ws, ws).run();
    await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id LIKE 'big-%'").run();
    const newEnc = await encryptSecret('t', NEW, ws);
    const oldEnc = await encryptSecret('t', OLD, ws);
    const ins = (id: string, enc: string) => env.DB.prepare("INSERT INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at) VALUES (?, ?, ?, 'own', 1, 1)").bind(id, ws, enc);
    for (let i = 0; i < 5000; i += 100) await env.DB.batch(Array.from({ length: 100 }, (_, j) => ins(`big-${String(i + j).padStart(5, '0')}`, newEnc)));
    await ins('big-99999', oldEnc).run(); // the 5,001st, last in id order
    const e = at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: OLD });
    // other tests' rows are all on the current key or removed by now; only the big table matters here
    await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id NOT LIKE 'big-%'").run();
    await env.DB.prepare('UPDATE phone_numbers SET pin_enc = NULL').run();
    const st = await rotationStatus(e);
    expect(st.total).toBe(5001);
    expect(st).toMatchObject({ onPrevious: 1, complete: false, truncated: false });
    // a pass that stops at its budget says so, even when everything it looked at was fine
    const part = await rotationStatus(e, { budget: 1000 });
    expect(part).toMatchObject({ onPrevious: 0, complete: false, truncated: true });
    expect(part.nextCursor).toBe('token:big-00999');
    expect(await rotationStatus(e, { budget: 10_000, cursor: part.nextCursor! })).toMatchObject({ onPrevious: 1, complete: false }); // a continuation cannot vouch for what is before it
    // the re-encrypt pass walks past the 5,000 rows already on the current key and reaches the last one
    expect(await rotateTokenKey(e, 100)).toMatchObject({ ok: true, rotated: 1, remaining: 0, complete: true }); // it walked past the 5,000 current-key rows, found the last one and left nothing behind
    expect(await rotationStatus(e)).toMatchObject({ onPrevious: 0, unreadable: 0, complete: true, truncated: false });
    expect(await rotateTokenKey(e, 100)).toMatchObject({ ok: true, rotated: 0, complete: true });
    await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id LIKE 'big-%'").run();
  });
  it('rotate refuses to run without a previous key, or with the same key twice (nothing to rotate)', async () => {
    await expect(rotateTokenKey(at({ TOKEN_ENC_KEY: NEW }), 10)).resolves.toMatchObject({ ok: false, reason: 'no_previous_key' });
    await expect(rotateTokenKey(at({ TOKEN_ENC_KEY: NEW, TOKEN_ENC_KEY_PREVIOUS: NEW }), 10)).resolves.toMatchObject({ ok: false, reason: 'same_key' });
  });
  it('the routes are operator-only', async () => {
    expect((await operatorCall(null, 'GET', '/token-key/status')).status).toBe(401);
    const call = (method: string) => worker.fetch(new Request('https://x/api/v1/operator/token-key/status', { method }), env, createExecutionContext());
    expect((await call('GET')).status).toBe(401);
    const ok = await operatorCall(OP1, 'GET', '/token-key/status');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ onPrevious: expect.any(Number), unreadable: expect.any(Number), previousKeyConfigured: false });
  });
});
