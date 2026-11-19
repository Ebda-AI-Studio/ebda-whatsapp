import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BARE_AR, BARE_EN } from '../foundation/brand';
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
  expect(createHash('sha256').update(file).digest('hex')).toBe('4fbfb22194b16b5d0becaff7e201251dc0d11ed754b2c626ae01b5f9bee9ee3d'); // contract v1.6 = Store apps/api/src/contracts/wa-v1.ts (Store #839 STORE-STANDING-1 + Store #811 COD v2 fields; Store #811 must carry these exact bytes)
});

it('shared web code names no brand: names, marks, hosts and colours come from web/brands/<brand>', () => {
  expect(findMatches(/ebda|إبدا/i, 'web/src').filter((m) => !/\.test\.tsx?:/.test(m))).toEqual([]);
});

it('the Worker reaches brand code only through the brand registry (src/brand.ts) and the identity selector', () => {
  expect(findMatches(/from '\.\/addons\//, 'src').filter((m) => m.startsWith('src/index.ts:'))).toEqual([]);
});

// Brand rule (suite-wide, same pattern as the Store repo's brand-name-never-bare guard): the company is "Ebda AI Studio" and every
// product is "Ebda <Product>"; a bare "Ebda" never reaches a user. The two regexes live in the foundation (`brand`), shared with the Store.
it('user-facing copy never says a bare "Ebda": always Ebda AI Studio or Ebda <Product>', () => {
  const scopes = ['src', 'web', 'docs/help', 'docs/legal', 'docs/site'];
  const hits = scopes.flatMap((s) => [...findMatches(BARE_EN, s), ...findMatches(BARE_AR, s)]).filter((m) => !/\.test\.tsx?:/.test(m));
  expect(hits).toEqual([]);
});

// Legal pages are formal Arabic (suite rule: Egyptian for product copy, formal for legal). A whole-word match on Arabic tokens, so a
// formal word that merely contains a marker never trips it. Add a marker here when review finds a new colloquial word.
it('the Arabic legal files are formal Arabic: no colloquial markers, products named in Arabic', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const COLLOQUIAL = ['اللي', 'بتاع', 'بتاعت', 'بتاعة', 'بيتم', 'بتتم', 'ده', 'دي', 'دول', 'مش', 'مفيش', 'عشان', 'علشان', 'إزاي', 'ازاي', 'كده', 'دلوقتي', 'بيعمل', 'بنعالج', 'بنستخدم', 'مبنبيعش'];
  for (const f of readdirSync(new URL('docs/legal/ar/', root))) {
    const text = readFileSync(new URL(`docs/legal/ar/${f}`, root), 'utf8');
    const found = (text.match(/[\u0600-\u06FF]+/g) ?? []).filter((w) => COLLOQUIAL.includes(w));
    expect([...new Set(found)], f).toEqual([]);
    expect(text, f).not.toMatch(/Ebda Chat|Ebda AI Studio/);
  }
});

// The Store publishes docs/legal on ebda.app from a vendored snapshot and cannot see this repo: a change here must be sent to the
// Store session (commit id) so it re-imports. Changing a file means updating its pin, which is the reminder.
const LEGAL_PINS: Record<string, string> = {
  'docs/legal/README.md': '7a5ce95ec44d49a1e73628e105e2005aa5879d599e6b4043b304720cc45cc7b6',
  'docs/legal/ar/whatsapp-dpa.md': '03b3d6fd5e963f7e2cce9113ca82e64fe6c33f2e76cec21204cc85745693cefa',
  'docs/legal/ar/whatsapp-privacy.md': '641b1e66c8b1fc6d325a701bd0bcab574a47b9358c938749fe6c88388e3fd9c1',
  'docs/legal/ar/whatsapp-terms.md': '40d83da0345e7ab019dcbcb97ccece2063fa100020d7723ff56fb9430ef1da69',
  'docs/legal/en/whatsapp-dpa.md': '689ae9647baa0bc03d6d22097bb6c61485bbc76aea14f1384acfd70d877f4269',
  'docs/legal/en/whatsapp-privacy.md': '555ed1b10626550dfaee37d394028de755143ad2daba551fb731497d57c91c7e',
  'docs/legal/en/whatsapp-terms.md': '0fb1e104a40f8dbbaf48802f42f50614eb5a0894cd49a6ed762e8ec5ac6fd01b',
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
  expect(sets.INFO.size).toBe(40); // + agent_model_timeout (a model call abandoned after 25 s) + agent_model_flag_unreadable (WA-MODEL-FLAG-1) + assistant_handoff, assistant_help_index_failed, assistant_status_failed (Smart Layer assistant) + 6 for the Chat agent context (agent_policies_unavailable, agent_profile_unavailable, agent_faq_not_indexed, handoff_owner_unreachable, handoff_owner_notice_failed, handoff_digest_failed) + instapay_auto_error (InstaPay auto-confirm: the request waits for a person); 20 + starter_templates_failed (template self-service: the screen retries) + catalog_items_rejected (WhatsApp catalogue) + P1b: seats_over_limit + W2-ABUSE: agent_turn_cap, agent_reply_blocked, campaign_content_blocked + W2-GROWTH: ai_credits_low + instapay_no_reference (DUP-REF-REQUIRED-1)
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
  expect(/export async function planPurchase[\s\S]*?\n}\n/.exec(orders)?.[0] ?? '').toMatch(/FROM packages WHERE id = \? AND active = 1 AND price_minor > 0/); // card checkout AND InstaPay both price through planPurchase
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
it('every DO migration has a `// vNN` label directly above it that matches its position (contiguous 1..N, none missing)', async () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src/core/do-migrations.ts'), 'utf8');
  const { DO_MIGRATIONS } = await import('../src/core/do-migrations');
  const start = src.indexOf('DO_MIGRATIONS: readonly string[] = [') + 'DO_MIGRATIONS: readonly string[] = ['.length;
  let entries = 0;
  const labels: { label: number; entry: number }[] = [];
  const labelled = new Set<number>();
  let pending: number | null = null; // the label seen since the previous entry ended
  let inTemplate = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (inTemplate) { if (ch === '\\') i++; else if (ch === '`') { inTemplate = false; entries++; pending = null; } continue; }
    if (ch === '/' && src[i + 1] === '/') { // a line comment outside a template: may carry a label, may contain backticks
      const end = src.indexOf('\n', i);
      const m = /^\/\/ v(\d+)\b/.exec(src.slice(i, end));
      if (m) { labels.push({ label: Number(m[1]), entry: entries + 1 }); pending = Number(m[1]); }
      i = end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') { // a block comment: skipped whole (it may hold backticks), a label in it counts the same
      const end = src.indexOf('*/', i + 2);
      const m = /^\/\*+\s*v(\d+)\b/.exec(src.slice(i, end));
      if (m) { labels.push({ label: Number(m[1]), entry: entries + 1 }); pending = Number(m[1]); }
      i = end + 1;
      continue;
    }
    if (ch === '`') { inTemplate = true; if (pending !== null) labelled.add(entries + 1); continue; }
    if (ch === ']' && src[i + 1] === ';') break;
  }
  expect(entries).toBe(DO_MIGRATIONS.length);
  expect(labels.filter((l) => l.label !== l.entry)).toEqual([]); // a mislabelled entry, or a slot inserted mid-array
  expect(DO_MIGRATIONS.map((_, i) => i + 1).filter((n) => !labelled.has(n))).toEqual([]); // an UNLABELLED entry
});

// D4 follow-up: a value published on a public route must never be derived from something shaped like a real person's phone number.
it('no string literal in src (outside tests and vectors) is an Egyptian E.164 mobile number', () => {
  expect(findMatches(/['"`]\+20\d{9,10}['"`]/, 'src')).toEqual([]);
});

// AUDIT-RETENTION-1 (review item 6): the audit log is append-only, so free text (which can hold a phone number) never goes into `detail`; an operator's reason goes to audit_reasons.
it('GUARD: no recordAudit call in src names a detail key reason / note / text / message / body', () => {
  const hits = findMatches(/recordAudit\(/, 'src');
  expect(hits.length).toBeGreaterThan(1);
  for (const h of hits) {
    const [file, line] = h.split(':') as [string, string];
    if (file.endsWith('core/audit.ts')) continue;
    const call = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n').slice(Number(line) - 1, Number(line) + 3).join(' ');
    const detail = /detail:\s*\{([^}]*)\}/.exec(call)?.[1] ?? '';
    expect(detail, `${file}:${line}`).not.toMatch(/\b(reason|note|text|message|body)\b\s*[:,}]/);
  }
});

// AUDIT-REASONS-1, the whole class: every table the migrations make append-only (a BEFORE UPDATE/DELETE trigger that RAISEs) holds no free text. A reason a person typed goes to
// audit_reasons and the immutable row carries `reason_id`; the legacy `reason` column may be named only next to `reason_id` (it gets the constant 'see reason_id' where NOT NULL).
it('GUARD: no INSERT into an append-only table (any table with a no-update trigger) names a free-text column', async () => {
  const { readdirSync } = await import('node:fs');
  const dir = new URL('../migrations/d1/', import.meta.url);
  const immutable = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/CREATE TRIGGER \w+ BEFORE UPDATE ON (\w+) BEGIN SELECT RAISE\(ABORT/g)) immutable.add(m[1]!);
  }
  // the tables the review named must be in the list, or the scan below proves nothing
  for (const t of ['audit_log', 'offboarding_log', 'operator_actions', 'billing_audit', 'instapay_releases', 'ledger_mirror', 'pricing_settings', 'workspace_pricing_overrides']) expect(immutable.has(t), t).toBe(true);
  const FREE = /^(reason|note|notes|text|message|body|comment|caption|detail_text)$/i;
  const { readdirSync: ls, statSync } = await import('node:fs');
  const files: string[] = [];
  const walkDir = (d: string): void => { for (const n of ls(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walkDir(p); else if (p.endsWith('.ts')) files.push(p); } };
  walkDir(join(import.meta.dirname, '..', 'src'));
  let scanned = 0;
  const bad: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
      if (!immutable.has(m[1]!)) continue;
      scanned++;
      const cols = m[2]!.split(',').map((c) => c.trim());
      for (const c of cols.filter((x) => FREE.test(x))) if (!(c.toLowerCase() === 'reason' && cols.includes('reason_id'))) bad.push(`${f.split('/src/')[1]}: ${m[1]} names ${c}`);
    }
  }
  expect(scanned).toBeGreaterThan(20);
  expect(bad, 'an append-only table must not store text: put it in audit_reasons and write reason_id (src/core/audit-reason.ts)').toEqual([]);
});

// Ruling WA-RENAME-PLAN-1 / WA-COPY-1 (Ahmad 2026-11-01): the product is "Ebda Chat" / "ابدأ شات". WhatsApp is only ever a describing phrase.
it('the product is never called Ebda WhatsApp (banned spellings, WA-COPY-1)', () => {
  const banned = /Ebda WhatsApp|ابدأ واتساب|Ebda for WhatsApp|WhatsApp by Ebda|\bEbda WA\b|شريك واتساب الرسمي/;
  const hits = findMatches(banned).filter((m) => !/^(docs\/rulings|graphify-out)\//.test(m) && !/^docs\/plans\//.test(m));
  expect(hits).toEqual([]);
});
