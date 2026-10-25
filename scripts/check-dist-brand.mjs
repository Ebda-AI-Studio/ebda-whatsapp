#!/usr/bin/env node
// A white-label deploy ships web/dist as it finds it. The web build stamps dist/brand.json with the brand it was built for;
// this refuses to go on when that stamp is missing or names another brand (a shared dist built for the suite brand would
// otherwise be served under a client's name, with the suite's sign-in host in its CSP).
// Usage: node scripts/check-dist-brand.mjs <dist-dir> <brand>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @returns {{ ok: boolean; detail: string }} */
export function checkDistBrand(distDir, brand) {
  let built;
  try {
    built = JSON.parse(readFileSync(join(distDir, 'brand.json'), 'utf8')).brand;
  } catch {
    return { ok: false, detail: `no readable ${join(distDir, 'brand.json')}: build the web app first with BRAND=${brand} npm run build:web` };
  }
  if (built !== brand) return { ok: false, detail: `web/dist was built for "${built}" but this deployment is "${brand}": rebuild with BRAND=${brand} npm run build:web` };
  return { ok: true, detail: `web/dist is built for "${brand}"` };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [dist, brand] = process.argv.slice(2);
  if (!dist || !brand) { console.error('usage: node scripts/check-dist-brand.mjs <dist-dir> <brand>'); process.exit(2); }
  const r = checkDistBrand(dist, brand);
  console[r.ok ? 'log' : 'error'](r.ok ? `ok: ${r.detail}` : `refused: ${r.detail}`);
  process.exit(r.ok ? 0 : 1);
}
