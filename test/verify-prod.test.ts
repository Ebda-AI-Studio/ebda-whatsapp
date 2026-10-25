import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { runChecks } from '../scripts/verify-prod.mjs';

const SECRET = 'app-secret-test';
const TOKEN = 'verify-token-test';
const COMMIT = 'abc1234';

/** A fake deployment that behaves like the real Worker: health, webhook handshake, signature check, security headers. */
function fakeDeploy(over: { commit?: string; noHsts?: boolean; acceptUnsigned?: boolean; brand?: string | null; csp?: string } = {}) {
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
    return new Response('nf', { status: 404 });
  };
}

describe('verify-prod', () => {
  it('passes every check against a healthy deployment', async () => {
    const r = await runChecks({ base: 'https://wa.test', expectCommit: COMMIT, expectBrand: 'ebda', verifyToken: TOKEN, appSecret: SECRET, fetchImpl: fakeDeploy() });
    expect(r.filter((c: { ok: boolean | null }) => c.ok !== true)).toEqual([]);
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
