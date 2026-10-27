import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { runChecks } from '../scripts/verify-prod.mjs';

const SECRET = 'app-secret-test';
const TOKEN = 'verify-token-test';
const COMMIT = 'abc1234';

/** A fake deployment that behaves like the real Worker: health, webhook handshake, signature check, security headers. */
function fakeDeploy(over: { kashierServedByAssets?: boolean; commit?: string; noHsts?: boolean; acceptUnsigned?: boolean; brand?: string | null; csp?: string } = {}) {
  const sec: Record<string, string> = over.noHsts ? {} : { 'strict-transport-security': 'max-age=63072000', 'x-content-type-options': 'nosniff' };
  return async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === '/health') return new Response(JSON.stringify({ ok: true, service: 'ebda-wa', commit: over.commit ?? COMMIT }), { headers: sec });
    if (u.pathname === '/') return new Response('<html></html>', { headers: { ...sec, 'content-security-policy': over.csp ?? "default-src 'self'; frame-ancestors 'none'" } });
    if (u.pathname === '/brand.json') return over.brand === null ? new Response('<html></html>') : new Response(JSON.stringify({ brand: over.brand ?? 'ebda' }));
    if (u.pathname === '/meta/webhook' && (init.method ?? 'GET') === 'GET') {
      return u.searchParams.get('hub.verify_token') === TOKEN ? new Response(u.searchParams.get('hub.challenge')) : new Response('forbidden', { status: 403 });
    }
    if (u.pathname === '/meta/webhook') {
      const body = String(init.body);
      const sig = new Headers(init.headers).get('x-hub-signature-256');
      const good = sig === `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
      return good || over.acceptUnsigned ? new Response('ok') : new Response('unauthorized', { status: 401 });
    }
    if (u.pathname === '/kashier/webhook') {
      if (over.kashierServedByAssets) return new Response('<html>spa</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(JSON.stringify({ error: 'invalid_signature' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    return new Response('nf', { status: 404 });
  };
}

describe('verify-prod', () => {
  it('passes every check against a healthy deployment', async () => {
    const deploy = fakeDeploy();
    const fetchImpl = async (url: string, init?: RequestInit) => (url.startsWith('https://api.cloudflare.com/') ? new Response(JSON.stringify({ success: true, result: { schedules: [{ cron: '17 1 * * *' }] } })) : deploy(url, init));
    const r = await runChecks({ base: 'https://wa.test', expectCommit: COMMIT, expectBrand: 'ebda', verifyToken: TOKEN, appSecret: SECRET, expectCron: '17 1 * * *', worker: 'ebda-wa', cfToken: 't', cfAccount: 'a', fetchImpl });
    expect(r.filter((c: { ok: boolean | null }) => c.ok !== true)).toEqual([]);
  });

  it('the card provider\'s webhook must be served by the Worker (an unsigned POST gets its 4xx JSON, not the SPA HTML)', async () => {
    const ok = await runChecks({ base: 'https://wa.test', fetchImpl: fakeDeploy() });
    expect(ok.find((c: { name: string }) => c.name === 'kashier webhook is served by the Worker')).toMatchObject({ ok: true });
    const spa = await runChecks({ base: 'https://wa.test', fetchImpl: fakeDeploy({ kashierServedByAssets: true }) });
    expect(spa.find((c: { name: string }) => c.name === 'kashier webhook is served by the Worker')).toMatchObject({ ok: false });
  });

  describe('the live cron schedule (Ruling #17: a registered schedule is proven from the API, not assumed from wrangler.jsonc)', () => {
    const withApi = (cron: string[] | 'error') => async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://api.cloudflare.com/')) {
        expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/workers/scripts/ebda-wa/schedules');
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-1');
        return cron === 'error' ? new Response('{"success":false}', { status: 403 }) : new Response(JSON.stringify({ success: true, result: { schedules: cron.map((c) => ({ cron: c })) } }));
      }
      return fakeDeploy()(url, init);
    };
    const run = (fetchImpl: never, extra: Record<string, unknown> = {}) => runChecks({ base: 'https://wa.test', expectCron: '17 1 * * *', worker: 'ebda-wa', cfToken: 'tok-1', cfAccount: 'acct-1', fetchImpl, ...extra });
    const cronCheck = (r: { name: string; ok: boolean | null; detail: string }[]) => r.find((c) => c.name === 'cron schedule registered live');
    it('passes and prints the live schedule when the expected cron is registered', async () => {
      const c = cronCheck(await run(withApi(['17 1 * * *']) as never));
      expect(c).toMatchObject({ ok: true });
      expect(c!.detail).toContain('17 1 * * *');
    });
    it('fails (and prints what IS registered) when the schedule is missing or different', async () => {
      const c = cronCheck(await run(withApi(['0 5 * * *']) as never))!;
      expect(c.ok).toBe(false);
      expect(c.detail).toContain('0 5 * * *');
      expect(cronCheck(await run(withApi([]) as never))).toMatchObject({ ok: false });
    });
    it('fails when the API cannot be read, and is SKIPPED (never passed) without credentials', async () => {
      expect(cronCheck(await run(withApi('error') as never))).toMatchObject({ ok: false });
      expect(cronCheck(await run(fakeDeploy() as never, { cfToken: undefined }))).toMatchObject({ ok: null });
    });
  });

  it('fails when the running commit is not the expected one', async () => {
    const r = await runChecks({ base: 'https://wa.test', expectCommit: COMMIT, fetchImpl: fakeDeploy({ commit: 'old9999' }) });
    expect(r.find((c: { name: string }) => c.name === 'health commit')).toMatchObject({ ok: false });
  });

  it('fails when the webhook accepts an unsigned post, or headers are missing', async () => {
    const r = await runChecks({ base: 'https://wa.test', fetchImpl: fakeDeploy({ acceptUnsigned: true, noHsts: true }) });
    expect(r.find((c: { name: string }) => c.name === 'webhook refuses unsigned')).toMatchObject({ ok: false });
    expect(r.find((c: { name: string }) => c.name === 'api security headers')).toMatchObject({ ok: false });
  });

  it('marks checks it could not run as skipped (null), never as passed', async () => {
    const r = await runChecks({ base: 'https://wa.test', fetchImpl: fakeDeploy() });
    const skipped = r.filter((c: { ok: boolean | null }) => c.ok === null).map((c: { name: string }) => c.name);
    expect(skipped).toEqual(expect.arrayContaining(['health commit', 'webhook handshake', 'webhook accepts signed']));
  });

  const CSP_EBDA = "default-src 'self'; connect-src 'self' https://accounts.ebda.app; frame-ancestors 'none'";
  const find = (r: { name: string }[], name: string) => r.find((c) => c.name === name);

  it('an empty running commit never matches the expected one (startsWith("") would pass any commit)', async () => {
    const r = await runChecks({ base: 'https://wa.test', expectCommit: COMMIT, fetchImpl: fakeDeploy({ commit: '' }) });
    expect(find(r, 'health commit')).toMatchObject({ ok: false });
  });

  it('a white-label tenant serving the suite brand\'s page is refused: wrong brand.json, or an ebda.app host in the CSP', async () => {
    const wrongBuild = await runChecks({ base: 'https://wa.test', expectBrand: 'acme', fetchImpl: fakeDeploy({ brand: 'ebda', csp: CSP_EBDA }) });
    expect(find(wrongBuild, 'web build brand')).toMatchObject({ ok: false });
    expect(find(wrongBuild, 'page CSP names no other brand')).toMatchObject({ ok: false });
    const csp = await runChecks({ base: 'https://wa.test', expectBrand: 'acme', fetchImpl: fakeDeploy({ brand: 'acme', csp: CSP_EBDA }) });
    expect(find(csp, 'web build brand')).toMatchObject({ ok: true });
    expect(find(csp, 'page CSP names no other brand')).toMatchObject({ ok: false });
    const good = await runChecks({ base: 'https://wa.test', expectBrand: 'acme', fetchImpl: fakeDeploy({ brand: 'acme' }) });
    expect(good.filter((c: { name: string; ok: boolean | null }) => /brand/.test(c.name) && c.ok !== true)).toEqual([]);
  });

  it('a page with no brand.json (an old build) fails the brand check; the suite brand may name its own host', async () => {
    const old = await runChecks({ base: 'https://wa.test', expectBrand: 'acme', fetchImpl: fakeDeploy({ brand: null }) });
    expect(find(old, 'web build brand')).toMatchObject({ ok: false });
    const suite = await runChecks({ base: 'https://wa.test', expectBrand: 'ebda', fetchImpl: fakeDeploy({ brand: 'ebda', csp: CSP_EBDA }) });
    expect(suite.filter((c: { name: string; ok: boolean | null }) => /brand/.test(c.name) && c.ok !== true)).toEqual([]);
  });

  it('without --brand the brand checks are skipped, never passed', async () => {
    const r = await runChecks({ base: 'https://wa.test', fetchImpl: fakeDeploy() });
    expect(find(r, 'web build brand')).toMatchObject({ ok: null });
  });
});
