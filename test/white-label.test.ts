import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { checkDistBrand } from '../scripts/check-dist-brand.mjs';

const root = join(import.meta.dirname, '..');
const tmp = mkdtempSync(join(tmpdir(), 'wl-'));
const rendered: string[] = [];
const rm = (p: string) => { try { rmSync(p, { recursive: true }); } catch { /* already gone */ } };
afterAll(() => { rm(tmp); for (const f of rendered) rm(f); });

const ACCOUNT = 'a'.repeat(32);
function render(identity: 'ebda' | 'oidc', prefix: string): string {
  execFileSync('bash', [join(root, 'deploy/white-label/bootstrap.sh'), '--account', ACCOUNT, '--prefix', prefix, '--brand', 'demo', '--identity', identity, '--url', 'https://wa.client.example', '--dry-run'], { cwd: root, stdio: 'pipe' });
  const out = join(root, 'deploy/white-label', `wrangler.${prefix}.jsonc`);
  rendered.push(out);
  return readFileSync(out, 'utf8');
}

describe('white-label deploy', () => {
  it('the web build stamps dist/brand.json with the brand it was built for', () => {
    const out = join(tmp, 'dist-demo');
    execFileSync('npx', ['vite', 'build', 'web', '--outDir', out], { cwd: root, env: { ...process.env, BRAND: 'demo' }, stdio: 'pipe' });
    expect(JSON.parse(readFileSync(join(out, 'brand.json'), 'utf8'))).toEqual({ brand: 'demo', oidcIssuer: 'https://login.demo-company.example/realms/main' });
  }, 120_000);

  it('refuses a dist built for another brand, an unstamped dist, or a missing one', () => {
    const dir = join(tmp, 'dist-check');
    mkdirSync(dir, { recursive: true });
    expect(checkDistBrand(join(tmp, 'nope'), 'demo')).toMatchObject({ ok: false });
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: false }); // no brand.json
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ brand: 'ebda' }));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ brand: 'demo' }));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: true });
  });

  it('a dist whose brand has its own OIDC provider must carry the issuer in its CSP, and match the issuer the operator expects', () => {
    const dir = join(tmp, 'dist-oidc');
    mkdirSync(dir, { recursive: true });
    const iss = 'https://login.client.example/realms/main';
    const csp = (connect: string, form: string) => `/*\n  Content-Security-Policy: default-src 'self'; connect-src 'self' ${connect}; form-action 'self' ${form}; frame-ancestors 'none'\n`;
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ brand: 'demo', oidcIssuer: iss }));
    writeFileSync(join(dir, '_headers'), csp('https://login.client.example', 'https://login.client.example'));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: true });
    expect(checkDistBrand(dir, 'demo', { expectIssuer: iss })).toMatchObject({ ok: true });
    expect(checkDistBrand(dir, 'demo', { expectIssuer: 'https://login.other.example/realms/main' })).toMatchObject({ ok: false });
    writeFileSync(join(dir, '_headers'), csp('https://login.client.example', ''));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: false }); // form-action lacks the issuer
    writeFileSync(join(dir, '_headers'), csp('', 'https://login.client.example'));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: false }); // connect-src lacks the issuer
    writeFileSync(join(dir, '_headers'), csp('https://login.client.example https://login.client.example.evil.example', 'https://login.client.example'));
    expect(checkDistBrand(dir, 'demo')).toMatchObject({ ok: false }); // a second host next to the issuer
  });

  it('the deploy script reads the brand from the rendered config and stops on a mismatch before deploying anything', () => {
    const sh = readFileSync(join(root, 'deploy/white-label/deploy.sh'), 'utf8');
    expect(existsSync(join(root, 'scripts/check-dist-brand.mjs'))).toBe(true);
    expect(sh).toContain('check-dist-brand.mjs');
    expect(sh.indexOf('check-dist-brand.mjs')).toBeLessThan(sh.indexOf('wrangler deploy'));
  });

  it('an OIDC tenant\'s config carries no suite identity host; an ebda-identity tenant gets it', () => {
    const oidc = render('oidc', 'wl-test-oidc');
    expect(oidc).not.toMatch(/ebda/i);
    expect(oidc).toContain('"IDENTITY_MODE": "oidc"');
    const suite = render('ebda', 'wl-test-ebda');
    expect(suite).toContain('https://accounts.ebda.app/.well-known/jwks.json');
    expect(suite).toContain('"IDENTITY_ISSUER": "https://accounts.ebda.app"');
  }, 60_000);
});

// WA-SUPPORT-1 (Ahmad): support is the Store's public email. It is vendored from the Store's brand constant (vendor/brand/store-support-email.json,
// pinned to a Store commit), and the Ebda brand, the help guides and the copy must all use that one address.
it('the Ebda support email is the vendored Store address, and no copy or guide says "contact support" without it', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const vendored = JSON.parse(read('vendor/brand/store-support-email.json')) as { supportEmail: string; storeCommit: string };
  expect(vendored.supportEmail).toMatch(/^[a-z0-9.]+@[a-z0-9.-]+\.[a-z]+$/);
  expect(vendored.storeCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(/supportEmail: '([^']+)'/.exec(read('web/brands/ebda/brand.ts'))?.[1]).toBe(vendored.supportEmail);
  const guides = ['ar', 'en'].flatMap((l) => readdirSync(new URL(`../docs/help/${l}/`, import.meta.url)).map((f) => `docs/help/${l}/${f}`));
  for (const f of [...guides, 'web/src/i18n.ts']) {
    const text = read(f);
    expect(/contact support|send [^.]* to support|كلّم الدعم|من الدعم/i.test(text), f).toBe(false);
    for (const m of text.matchAll(/[a-z0-9.]+@ebda\.app/g)) if (!m[0].startsWith('privacy@')) expect(m[0], f).toBe(vendored.supportEmail);
  }
});
