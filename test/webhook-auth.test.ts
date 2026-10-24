import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '../src/core/meta/signature';
import { postWebhook, sign } from './helpers/meta';

const EMPTY = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

describe('GET /meta/webhook', () => {
  it('echoes hub.challenge when the verify token matches', async () => {
    const r = await SELF.fetch('https://x/meta/webhook?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=123');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('123');
  });
  it('rejects a wrong verify token', async () => {
    const r = await SELF.fetch('https://x/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123');
    expect(r.status).toBe(403);
  });
});

describe('POST /meta/webhook', () => {
  it('accepts a valid X-Hub-Signature-256', async () => {
    expect((await postWebhook(SELF, EMPTY)).status).toBe(200);
  });
  it('is 401 for a tampered body', async () => {
    const sig = await sign(EMPTY);
    const r = await postWebhook(SELF, EMPTY.replace('[]', '[ ]'), sig);
    expect(r.status).toBe(401);
  });
  it('is 401 with no signature header', async () => {
    expect((await postWebhook(SELF, EMPTY, null)).status).toBe(401);
  });
  it('checks the raw bytes, not re-serialised JSON', async () => {
    const raw = '{ "object":"whatsapp_business_account",  "entry":[], "note":"\\u0627" }';
    expect((await postWebhook(SELF, raw)).status).toBe(200);
  });
});

describe('verifyMetaSignature', () => {
  const body = new TextEncoder().encode('abc').buffer as ArrayBuffer;
  it('rejects a header of the wrong length', async () => {
    expect(await verifyMetaSignature(body, 'sha256=abcd', 'test-secret')).toBe(false);
  });
  it('rejects a header without the sha256= prefix', async () => {
    const good = (await sign('abc')).slice('sha256='.length);
    expect(await verifyMetaSignature(body, good, 'test-secret')).toBe(false);
  });
});
