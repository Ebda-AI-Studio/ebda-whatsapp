import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectNumberRequest } from '../src/core/api/contract';
import { TEST_APP_SECRET } from './helpers/meta';
import { stubGraph } from './helpers/graph';
import { seedOwnNumber } from './helpers/own-number';

// B9: Meta's "Data Deletion Request URL" is OUR route. Meta POSTs a signed_request when a person removes the app; we verify it (HMAC-SHA256 over the payload with
// the app secret), queue the erasure, and answer { url, confirmation_code } as Meta's spec says. NOT VERIFIED against Meta's live callback (docs/launch/README.md s4).
afterEach(() => vi.restoreAllMocks());
const b64url = (b: ArrayBuffer | Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...new Uint8Array(b as ArrayBuffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function signedRequest(payload: Record<string, unknown>, secret = TEST_APP_SECRET): Promise<string> {
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p)))}.${p}`;
}
const post = (sr: string | null, headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }) =>
  SELF.fetch('https://x/meta/data-deletion', { method: 'POST', headers, body: sr === null ? '' : new URLSearchParams({ signed_request: sr }).toString() });
const PAYLOAD = (user = '1234567890123456', extra: Record<string, unknown> = {}) => ({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: user, ...extra });
const request = (code: string) => env.DB.prepare('SELECT state, removed_connections FROM meta_deletion_requests WHERE code = ?').bind(code).first<{ state: string; removed_connections: number }>();
const count = () => env.DB.prepare('SELECT count(*) AS n FROM meta_deletion_requests').first<{ n: number }>().then((r) => r!.n);

describe('the callback', () => {
  it('a genuine signed_request is answered with the status URL and a confirmation code, as Meta specifies', async () => {
    const res = await post(await signedRequest(PAYLOAD('555000111')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
    expect(body.url).toBe(`https://x/meta/data-deletion/status?code=${body.confirmation_code}`);
    expect(Object.keys(body).sort()).toEqual(['confirmation_code', 'url']);
  });

  it('refuses everything that is not a genuine signed request: wrong secret, wrong algorithm, no user id, garbage, nothing; and stores nothing', async () => {
    const before = await count();
    const bad: (string | null)[] = [
      await signedRequest(PAYLOAD(), 'another-secret'), await signedRequest(PAYLOAD('1', { algorithm: 'HMAC-SHA1' })), await signedRequest({ algorithm: 'HMAC-SHA256', issued_at: 1 }),
      await signedRequest(PAYLOAD('not-digits')), 'garbage', 'a.b', '.', null,
    ];
    for (const sr of bad) {
      const res = await post(sr);
      expect(res.status, String(sr).slice(0, 20)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_request' });
    }
    expect(await count()).toBe(before);
  });

  it('a payload with a tampered body is refused even when the signature is a real one for another payload', async () => {
    const good = await signedRequest(PAYLOAD('777'));
    const other = await signedRequest(PAYLOAD('888'));
    expect((await post(`${good.split('.')[0]}.${other.split('.')[1]}`)).status).toBe(400);
  });

  it('the same request twice is the same confirmation code (Meta retries), and one stored row', async () => {
    const sr = await signedRequest(PAYLOAD('999', { issued_at: 1_800_000_000 }));
    const a = (await (await post(sr)).json()) as { confirmation_code: string };
    const b = (await (await post(sr)).json()) as { confirmation_code: string };
    expect(b.confirmation_code).toBe(a.confirmation_code);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM meta_deletion_requests WHERE code = ?').bind(a.confirmation_code).first('n')).toBe(1);
  });

  it('is a form POST only and small: JSON is 415 and a big body is 413', async () => {
    expect((await post(await signedRequest(PAYLOAD()), { 'content-type': 'application/json' })).status).toBe(415);
    const big = await SELF.fetch('https://x/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `signed_request=${'a'.repeat(20_000)}` });
    expect(big.status).toBe(413);
  });
});

describe('the erasure', () => {
  it('removes every connection the person made: numbers disconnected, tokens and PINs gone, the id forgotten, state done', async () => {
    await seedOwnNumber('pn-del-1', 'ws-del-1', 'waba-del-1', 'tok-del-1');
    await seedOwnNumber('pn-del-2', 'ws-del-2', 'waba-del-2', 'tok-del-2');
    await env.DB.prepare("UPDATE waba_credentials SET fb_user_id = '424242' WHERE waba_id IN ('waba-del-1', 'waba-del-2')").run();
    const g = stubGraph();
    const { confirmation_code } = (await (await post(await signedRequest(PAYLOAD('424242')))).json()) as { confirmation_code: string };
    const done = await vi.waitFor(async () => { const r = await request(confirmation_code); if (r?.state !== 'done') throw new Error(r?.state); return r; }, { timeout: 5000 });
    expect(done).toEqual({ state: 'done', removed_connections: 2 });
    expect(await env.DB.prepare("SELECT status FROM phone_numbers WHERE phone_number_id IN ('pn-del-1', 'pn-del-2') ORDER BY phone_number_id").all()).toMatchObject({ results: [{ status: 'disconnected' }, { status: 'disconnected' }] });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM waba_credentials WHERE fb_user_id = '424242' OR waba_id IN ('waba-del-1', 'waba-del-2')").first('n')).toBe(0);
    g.restore();
  });

  it('a person we cannot match is not "done": the request waits for a human (state nothing_found) and a P1 alert asks for one', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const { confirmation_code } = (await (await post(await signedRequest(PAYLOAD('31313131')))).json()) as { confirmation_code: string };
    await vi.waitFor(async () => { if ((await request(confirmation_code))?.state !== 'nothing_found') throw new Error('not yet'); }, { timeout: 5000 });
    expect(logs.some((l) => l.includes('"alert":"meta_deletion_needs_review"'))).toBe(true);
    expect(logs.join('\n')).not.toContain('31313131'); // the Meta user id is never logged
  });

  it('the Meta user id is not kept: the request row holds a hash', async () => {
    await post(await signedRequest(PAYLOAD('60606060')));
    const rows = await env.DB.prepare('SELECT * FROM meta_deletion_requests').all();
    expect(JSON.stringify(rows.results)).not.toContain('60606060');
  });
});

describe('the status page', () => {
  it('JSON for a program, HTML for a person; the code is the only key and nothing personal is shown', async () => {
    const { confirmation_code, url } = (await (await post(await signedRequest(PAYLOAD('70707070')))).json()) as { confirmation_code: string; url: string };
    await vi.waitFor(async () => { if (!['done', 'nothing_found'].includes((await request(confirmation_code))?.state ?? '')) throw new Error('not yet'); }, { timeout: 5000 });
    const json = await SELF.fetch(url, { headers: { accept: 'application/json' } });
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ code: confirmation_code, status: 'needs_review', removedConnections: 0 });
    const html = await SELF.fetch(url, { headers: { accept: 'text/html' } });
    expect(html.headers.get('content-type')).toContain('text/html');
    const page = await html.text();
    expect(page).toContain(confirmation_code);
    expect(page).toContain('ahlan@ebda.app');
    expect(page).not.toContain('70707070');
    expect((await SELF.fetch('https://x/meta/data-deletion/status?code=' + 'f'.repeat(32))).status).toBe(404);
    expect((await SELF.fetch('https://x/meta/data-deletion/status?code=nope')).status).toBe(404);
  });
  it('GET /meta/data-deletion without a code is the instructions page (the URL a person can read)', async () => {
    const res = await SELF.fetch('https://x/meta/data-deletion', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ahlan@ebda.app');
  });
});

describe('Embedded Signup remembers who connected, so a deletion request can find the connection', () => {
  it('the connect request may carry the app-scoped user id (digits only)', () => {
    const base = { code: 'c', event: 'FINISH' as const, wabaId: '1', phoneNumberId: '2' };
    expect(connectNumberRequest.parse({ ...base, fbUserId: '123456' }).fbUserId).toBe('123456');
    expect(connectNumberRequest.safeParse({ ...base, fbUserId: '12 34' }).success).toBe(false);
    expect(connectNumberRequest.safeParse({ ...base, fbUserId: '1'.repeat(41) }).success).toBe(false);
    expect(connectNumberRequest.parse(base).fbUserId).toBeUndefined();
  });
});
