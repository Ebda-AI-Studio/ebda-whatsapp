import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { findMatches } from './helpers/grep';

it('repo carries no legacy brand strings', () => {
  expect(findMatches(/force|fwb|\bwbs\b|forcemediakw/i)).toEqual([]);
});

it('money code never uses INSERT OR IGNORE (it also swallows CHECK violations: a row with a bad state would vanish); use ON CONFLICT DO NOTHING', () => {
  expect(findMatches(/INSERT OR IGNORE/i, 'src/core/billing')).toEqual([]);
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
  'docs/legal/ar/whatsapp-terms.md': '4038e770687b89d5d0b7005b33c48812d2e595860efb194c72b0bcb2e8e4e3e8',
  'docs/legal/en/whatsapp-dpa.md': '8cfe9328d4478c1150c2c445835b0761c4a7f90849301d69dbe4e777b7f4a65a',
  'docs/legal/en/whatsapp-privacy.md': '139b5484f759014a0245ebbbf90b3a504aebf324717f98bbd3426397ade7008a',
  'docs/legal/en/whatsapp-terms.md': '155f31f7b3a46b80d2cc8b7980193ff3b9a4704ae04e4306b004cbaebf7c325a',
};
it('legal pages are pinned: a change needs a new pin AND a message to the Store session, which publishes them', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const root = new URL('../', import.meta.url);
  const files = ['docs/legal/README.md', ...['ar', 'en'].flatMap((l) => readdirSync(new URL(`docs/legal/${l}/`, root)).map((f) => `docs/legal/${l}/${f}`))];
  expect(files.sort()).toEqual(Object.keys(LEGAL_PINS).sort());
  for (const f of files) expect(createHash('sha256').update(readFileSync(new URL(f, root))).digest('hex'), f).toBe(LEGAL_PINS[f]);
});

// Role checks are positive allow-lists. A negative check (`storeRole !== 'staff'`) would grant owner powers to any role added later
// (e.g. an integration principal), so routes ask "is this an owner or a super admin?" through managesStore() instead.
it('routes never decide owner powers with a negative role check', () => {
  expect(findMatches(/!==?\s*'staff'|'staff'\s*!==?/, 'src')).toEqual([]);
});

// ---- Alerts: every name has a decided severity (W1-OBS) ----
it('every alert name used in src is in exactly one of P0_ALERTS / P1_ALERTS / INFO_ALERTS, so a new name fails CI until someone picks its severity', async () => {
  const { readFileSync } = await import('node:fs');
  const obs = readFileSync(new URL('../src/core/observability.ts', import.meta.url), 'utf8');
  const setOf = (name: string): Set<string> => {
    const body = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(obs)?.[1] ?? '';
    return new Set([...body.replace(/\/\/[^\n]*/g, '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!));
  };
  const sets = { P0: setOf('P0_ALERTS'), P1: setOf('P1_ALERTS'), INFO: setOf('INFO_ALERTS') };
  expect(sets.P0.size).toBeGreaterThan(5);
  expect(sets.P1.size).toBeGreaterThan(40);
  expect(sets.INFO.size).toBe(20);
  const used = new Set<string>();
  for (const hit of findMatches(/\balert\(/, 'src')) {
    const [file, line] = hit.split(':') as [string, string];
    if (file.endsWith('core/observability.ts')) continue;
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n').slice(Number(line) - 1).join('\n');
    // The first argument: up to the first comma at depth 0 (a ternary may name several alerts).
    let depth = 0;
    let arg = '';
    for (const ch of text.slice(text.indexOf('alert(') + 6)) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      arg += ch;
    }
    for (const m of arg.matchAll(/'([a-z0-9_]+)'/g)) used.add(m[1]!);
  }
  expect(used.size).toBeGreaterThan(60);
  const wrong = [...used].filter((n) => [sets.P0, sets.P1, sets.INFO].filter((s) => s.has(n)).length !== 1);
  expect(wrong, 'alert names with no severity (or more than one): add each to exactly one set in observability.ts').toEqual([]);
  for (const a of ['P0', 'P1'] as const) for (const b of ['P1', 'INFO'] as const) if (a !== b) expect([...sets[a]].filter((n) => sets[b].has(n)), `${a} and ${b} overlap`).toEqual([]);
});

// DIGITS-1 (Ahmad): Western digits 0-9 everywhere a person reads a number. Never Arabic-Indic (٠-٩) or Persian (۰-۹), in the Arabic UI too.
// 1) Intl / toLocale* may name an Arabic locale only with the latin numbering system (`ar-EG-u-nu-latn`).
it('DIGITS-1: no Arabic locale reaches Intl / toLocale* without -u-nu-latn (it would print ٠-٩)', () => {
  const call = /Intl\.(NumberFormat|DateTimeFormat|RelativeTimeFormat|ListFormat|PluralRules)\(|toLocale(Date|Time)?String\(/;
  const arabicLocale = /['"`]ar(-[A-Za-z]{2})?(-u-[A-Za-z0-9-]+)?['"`]\s*[,)]|['"`]ar-[A-Za-z]{2}(-u-[A-Za-z0-9-]+)?['"`]/g;
  const hits: string[] = [];
  for (const scope of ['src', 'web/src']) {
    for (const m of findMatches(call, scope)) {
      const [file, line] = m.split(':') as [string, string];
      if (/\.test\.tsx?$/.test(file)) continue;
      const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8').split('\n')[Number(line) - 1]!;
      for (const lit of text.match(arabicLocale) ?? []) if (!lit.includes('nu-latn')) hits.push(`${m}  ${lit}`);
    }
  }
  expect(hits).toEqual([]);
});

// 2) No Arabic-Indic / Persian digit in anything a user can read. INPUT-side code may still name them (it must ACCEPT what people type),
// listed by path with the reason; test files (vectors, expectations of typed input) are not scanned.
const ARABIC_DIGIT = /[٠-٩۰-۹]/;
const INPUT_SIDE: Record<string, string> = {
  'src/core/text-normalise.ts': 'normaliseText / phoneDigits fold typed ٠-٩ and ۰-۹ to 0-9 (input side)',
  'src/core/phone.ts': 'normaliseE164 accepts digits typed in Arabic-Indic or Persian form (input side)',
  'src/core/shared/shared-number.ts': 'customer key folds typed digits before hashing (input side)',
  'web/src/lib/rates.ts': 'parses a price typed with Arabic-Indic digits (input side)',
  'web/src/components/WalletScreen.tsx': 'parses an amount typed with Arabic-Indic digits (input side)',
};
const WHOLLY_INPUT = new Set(['src/core/text-normalise.ts', 'src/core/phone.ts']);
it('DIGITS-1: no ٠-٩ / ۰-۹ in code, copy, templates, brands, help, legal or site docs (except the input-side normalisers)', () => {
  const hits: string[] = [];
  for (const scope of ['src', 'web', 'docs/help', 'docs/legal', 'docs/site']) {
    for (const m of findMatches(ARABIC_DIGIT, scope)) {
      const [file, line] = m.split(':') as [string, string];
      if (/\.test\.tsx?$/.test(file) || !/\.(tsx?|mjs|js|json|html|css|svg|md|mdx|txt)$/.test(file)) continue; // tests are not user-facing; images are binary
      if (INPUT_SIDE[file]) {
        const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8').split('\n')[Number(line) - 1]!;
        // Files that are wholly input normalisers may name the digits anywhere (also in their comments); mixed files only in the conversion tables.
        if (WHOLLY_INPUT.has(file) || /\[٠-٩|\[۰-۹|'٠١٢٣٤٥٦٧٨٩'|'۰۱۲۳۴۵۶۷۸۹'/.test(text)) continue;
      }
      hits.push(m);
    }
  }
  expect(hits).toEqual([]);
});

// ---- WA-NOFREE-1: there is no free plan ----
it('across the D1 migrations, a package with price_minor = 0 is only ever store-included', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../migrations/d1/', import.meta.url);
  const seen: { id: string; price: number; file: string }[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for (const stmt of sql.split(';').filter((s) => /INSERT\s+(OR\s+\w+\s+)?INTO\s+packages\b/i.test(s))) {
      for (const m of stmt.matchAll(/\(\s*'([\w-]+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,/g)) seen.push({ id: m[1]!, price: Number(m[2]), file: f });
    }
  }
  expect(seen.map((s) => s.id)).toEqual(expect.arrayContaining(['store-included', 'starter', 'growth', 'pro'])); // the parse is not vacuous
  expect(seen.filter((s) => s.price === 0 && s.id !== 'store-included')).toEqual([]);
});

it('store-included is only ever written by the Store-plan path (store-plan.ts and the fallback to it in subscriptions.ts)', async () => {
  const files = [...new Set(findMatches(/store-included|STORE_INCLUDED/, 'src').map((m) => m.split(':')[0]!))].sort();
  expect(files).toEqual(['src/core/billing/store-plan.ts', 'src/core/billing/subscriptions.ts', 'src/routes/operator.ts']);
  expect(findMatches(/STORE_INCLUDED/, 'src/routes').length).toBe(2); // operator.ts: the import and the refusal, nothing that writes it
  // The other two writers of workspace_subscriptions take an id from outside, so each must refuse the free package where it takes it.
  const { readFileSync } = await import('node:fs');
  // The listing a merchant buys from: the SQL string of listPackages itself must filter price_minor > 0 (not just mention it somewhere).
  const orders = readFileSync(new URL('../src/core/billing/package-orders.ts', import.meta.url), 'utf8');
  const listing = /export async function listPackages[\s\S]*?\n}\n/.exec(orders)?.[0] ?? '';
  expect(listing).toMatch(/FROM packages WHERE[^']*active = 1[^']*price_minor > 0/);
  expect(/export async function startPackageCheckout[\s\S]*?\n}\n/.exec(orders)?.[0] ?? '').toMatch(/FROM packages WHERE id = \? AND active = 1 AND price_minor > 0/);
  expect(readFileSync(new URL('../src/routes/operator.ts', import.meta.url), 'utf8')).toMatch(/store_included_is_store_plan_only/);
});

// migrate() applies DO_MIGRATIONS by array POSITION past max(_migrations.version): the version IS the index. Numbers go in merge order and are never reserved.
//  (a) a no-op "placeholder to be replaced later" would be skipped forever on every DO that already ran it;
//  (b) a `// vNN` label must sit directly above entry NN, so a slot inserted mid-array or a mislabelled entry breaks the numbering the docs and reviews quote.
it('no DO migration is a no-op or a placeholder (empty, or only SELECT 1)', async () => {
  const { DO_MIGRATIONS } = await import('../src/core/do-migrations');
  const noop = DO_MIGRATIONS.map((sql, i) => ({ v: i + 1, sql: sql.replace(/--[^\n]*/g, '').trim() })).filter((m) => m.sql === '' || /^(SELECT\s+1;?\s*)+$/i.test(m.sql));
  expect(noop.map((m) => `v${m.v}`)).toEqual([]);
});
it('every `// vNN` label in do-migrations.ts sits directly above entry NN, in order (versions are contiguous 1..N)', async () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/core/do-migrations.ts'), 'utf8');
  const { DO_MIGRATIONS } = await import('../src/core/do-migrations');
  const start = src.indexOf('DO_MIGRATIONS: readonly string[] = [') + 'DO_MIGRATIONS: readonly string[] = ['.length;
  let entries = 0;
  const labels: { label: number; entry: number }[] = [];
  let inTemplate = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inTemplate) { if (ch === '\\') i++; else if (ch === '`') { inTemplate = false; entries++; } continue; }
    if (ch === '/' && src[i + 1] === '/') { // a comment outside a template: may carry a label, may contain backticks
      const end = src.indexOf('\n', i);
      const m = /^\/\/ v(\d+)\b/.exec(src.slice(i, end));
      if (m) labels.push({ label: Number(m[1]), entry: entries + 1 });
      i = end;
      continue;
    }
    if (ch === '`') { inTemplate = true; continue; }
    if (ch === ']' && src[i + 1] === ';') break;
  }
  expect(entries).toBe(DO_MIGRATIONS.length);
  expect(labels.length).toBeGreaterThan(20);
  expect(labels.filter((l) => l.label !== l.entry)).toEqual([]);
  expect(labels.map((l) => l.label)).toEqual([...labels.map((l) => l.label)].sort((a, b) => a - b));
});
