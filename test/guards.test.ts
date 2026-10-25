import { expect, it } from 'vitest';
import { findMatches } from './helpers/grep';

it('repo carries no legacy brand strings', () => {
  expect(findMatches(/force|fwb|\bwbs\b|forcemediakw/i)).toEqual([]);
});

it('core never names the Ebda brand', () => {
  expect(findMatches(/ebda|إبدأ|ابدأ/i, 'src/core')).toEqual([]);
});

it('pins the Store event contract file: change it only together with the Store repo copy', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const file = readFileSync(new URL('../src/core/api/store-events.ts', import.meta.url));
  expect(createHash('sha256').update(file).digest('hex')).toBe('d0ae7d8757b3807e325bdf5523680e7a098d121272dd0854e7d2a97ff60bdf23');
});

it('shared web code names no brand: names, marks, hosts and colours come from web/brands/<brand>', () => {
  expect(findMatches(/ebda|إبدا/i, 'web/src').filter((m) => !/\.test\.tsx?:/.test(m))).toEqual([]);
});

it('the Worker reaches brand code only through the brand registry (src/brand.ts) and the identity selector', () => {
  expect(findMatches(/from '\.\/addons\//, 'src').filter((m) => m.startsWith('src/index.ts:'))).toEqual([]);
});

// Brand rule (suite-wide, same pattern as the Store repo's brand-name-never-bare guard): the company is "Ebda AI Studio" and every
// product is "Ebda <Product>"; a bare "Ebda" never reaches a user. Header/identifier names (X-Ebda-…, Ebda-Webhooks) are not copy.
const BARE_EN = /(?<!X-)\bEbda\b(?!-Webhooks)(?! (?:Store|AI Studio|WhatsApp|CRM|ERP)\b)/;
// The Arabic brand spellings with hamza under alef; the plain ابدأ is the everyday verb "start" and stays allowed in copy.
const BARE_AR = /(?:إبدأ|إبدا)(?!\s*(?:ستور|استوديو|واتساب|WhatsApp|CRM|ERP|Store)(?![ء-يٱ-ۓ]))/;
it('user-facing copy never says a bare "Ebda": always Ebda AI Studio or Ebda <Product>', () => {
  const scopes = ['src', 'web', 'docs/help', 'docs/legal', 'docs/site'];
  const hits = scopes.flatMap((s) => [...findMatches(BARE_EN, s), ...findMatches(BARE_AR, s)]).filter((m) => !/\.test\.tsx?:/.test(m));
  expect(hits).toEqual([]);
});

// The Store publishes docs/legal on ebda.app from a vendored snapshot and cannot see this repo: a change here must be sent to the
// Store session (commit id) so it re-imports. Changing a file means updating its pin, which is the reminder.
const LEGAL_PINS: Record<string, string> = {
  'docs/legal/README.md': '3e2ac6be2d00104de0be887baab908784ba2468e0e97761579646c2640b8cf31',
  'docs/legal/ar/whatsapp-dpa.md': '43dfa98c3dc681bc047ff7f04738279a326d6e71d80d9c1afbb75bb2c0975e51',
  'docs/legal/ar/whatsapp-privacy.md': '93cc40cde3913d7f0c31bcbe5c93a1b63e5676250528b282b8ff45a9f4e59cc8',
  'docs/legal/ar/whatsapp-terms.md': '83ff0b9a36f3fbda22adec3f1be5813190e855a8ce780587130c4ff93b0efbca',
  'docs/legal/en/whatsapp-dpa.md': '8cfe9328d4478c1150c2c445835b0761c4a7f90849301d69dbe4e777b7f4a65a',
  'docs/legal/en/whatsapp-privacy.md': '139b5484f759014a0245ebbbf90b3a504aebf324717f98bbd3426397ade7008a',
  'docs/legal/en/whatsapp-terms.md': 'c4d72c46ca6a74b57eabf2c5ec86e89edf08b94ac06ac07c4287da3eeea064d8',
};
it('legal pages are pinned: a change needs a new pin AND a message to the Store session, which publishes them', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const root = new URL('../', import.meta.url);
  const files = ['docs/legal/README.md', ...['ar', 'en'].flatMap((l) => readdirSync(new URL(`docs/legal/${l}/`, root)).map((f) => `docs/legal/${l}/${f}`))];
  expect(files.sort()).toEqual(Object.keys(LEGAL_PINS).sort());
  for (const f of files) expect(createHash('sha256').update(readFileSync(new URL(f, root))).digest('hex'), f).toBe(LEGAL_PINS[f]);
});
