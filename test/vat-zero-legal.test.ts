import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
// The suite's single VAT-0 clause (business/ebda/legal/VAT-0-clause.md), vendored byte for byte; the store product publishes the same text.
const CLAUSE_SHA = '9e308d934800b655673aa0491ec88f822811e79bc01793d7ca43067fd22c50a0';
const clause = read('vendor/legal/VAT-0-clause.md');
const section = (h: string) => clause.split(`## ${h}\n`)[1]!.split('\n## ')[0]!.trim();

it('the vendored VAT-0 clause is the pinned suite text', () => {
  expect(createHash('sha256').update(clause).digest('hex')).toBe(CLAUSE_SHA);
});

it('terms 6.6 carry the VAT-0 paragraph verbatim, in both languages, and nothing else says VAT is added', () => {
  const en = read('docs/legal/en/whatsapp-terms.md');
  const ar = read('docs/legal/ar/whatsapp-terms.md');
  expect(en).toContain(`6.6 ${section('English')}`);
  expect(ar).toContain(`6.6 ${section('العربية')}`);
  expect(en).not.toMatch(/stated before value-added tax|PENDING LEGAL REVIEW: VAT/);
  expect(ar).not.toMatch(/PENDING LEGAL REVIEW: VAT/);
});

it('no D1 migration seeds a VAT above 0', () => {
  for (const f of readdirSync(join(root, 'migrations/d1'))) {
    const sql = read(`migrations/d1/${f}`);
    for (const m of sql.matchAll(/INSERT INTO pricing_settings[^;]*?VALUES\s*\(([^)]*)\)/gis)) {
      const vals = m[1]!.split(',').map((v) => v.trim());
      expect(vals[5], `${f}: vat_bps`).toBe('0');
    }
  }
});
