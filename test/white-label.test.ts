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
    expect(JSON.parse(readFileSync(join(out, 'brand.json'), 'utf8'))).toEqual({ brand: 'demo' });
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
