#!/usr/bin/env node
// A white-label deploy ships web/dist as it finds it. The web build stamps dist/brand.json with the brand it was built for;
// this refuses to go on when that stamp is missing or names another brand (a shared dist built for the suite brand would
// otherwise be served under a client's name, with the suite's sign-in host in its CSP).
// Usage: node scripts/check-dist-brand.mjs <dist-dir> <brand>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns {{ ok: boolean; detail: string }} */
export function checkDistBrand(distDir, brand, opts = {}) {
  let built;
  let issuer;
  try {
    const stamp = JSON.parse(readFileSync(join(distDir, 'brand.json'), 'utf8'));
    built = stamp.brand;
    issuer = stamp.oidcIssuer;
  } catch {
    return { ok: false, detail: `no readable ${join(distDir, 'brand.json')}: build the web app first with BRAND=${brand} npm run build:web` };
  }
  if (built !== brand) return { ok: false, detail: `web/dist was built for "${built}" but this deployment is "${brand}": rebuild with BRAND=${brand} npm run build:web` };
  if (issuer) {
    // A brand on its own identity provider: the page talks to that issuer, so its CSP must name that origin (and no other host next to it),
    // and it must be the issuer the Worker verifies tokens for.
    const origin = new URL(issuer).origin;
    let csp = '';
    try {
      csp = /Content-Security-Policy: (.+)$/m.exec(readFileSync(join(distDir, '_headers'), 'utf8'))?.[1] ?? '';
    } catch { /* reported below */ }
    const dir = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);
    const external = (list) => list.filter((t) => t.startsWith('https://') && !t.includes('facebook.') && !t.includes('fbcdn.'));
    if (JSON.stringify(external(dir('connect-src'))) !== JSON.stringify([origin]) || !dir('form-action').includes(origin)) {
      return { ok: false, detail: `the brand's sign-in issuer is ${origin} but web/dist/_headers does not list exactly that origin in connect-src and form-action` };
    }
    if (opts.expectIssuer && opts.expectIssuer !== issuer) {
      return { ok: false, detail: `the brand's issuer (${issuer}) differs from the issuer in the tenant's IDENTITY_OIDC_CONFIG (${opts.expectIssuer}): tokens would never verify` };
    }
  }
  return { ok: true, detail: `web/dist is built for "${brand}"${issuer ? ` (sign-in issuer ${issuer})` : ''}` };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [dist, brand] = process.argv.slice(2);
  const expectIssuer = process.env.OIDC_ISSUER || undefined;
  if (!dist || !brand) { console.error('usage: node scripts/check-dist-brand.mjs <dist-dir> <brand>'); process.exit(2); }
  const r = checkDistBrand(dist, brand, { expectIssuer });
  console[r.ok ? 'log' : 'error'](r.ok ? `ok: ${r.detail}` : `refused: ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}
