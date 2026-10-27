import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Ruling MONEY-FACT-1 (a node-project test: it reads the source). A refund or chargeback is an external fact and is never rejected, so there is no database trigger that aborts it;
 * instead EVERY statement that writes topups.refunded_minor or package_orders.refunded_minor clamps with MIN(amount_minor, ...). A new writer that forgets fails here.
 */
const DIR = new URL('../src/core/billing/', import.meta.url);
export function scanWriters(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [f, text] of Object.entries(files)) {
    for (const m of text.matchAll(/UPDATE\s+(topups|package_orders)\s+SET\s+([\s\S]{0,400}?)\bWHERE\b/g)) {
      if (!/refunded_minor\s*=/.test(m[2]!)) continue;
      out.push(`${f}: ${/refunded_minor\s*=\s*MIN\(\s*amount_minor\s*,/i.test(m[2]!) ? 'clamped' : 'UNCLAMPED'}`);
    }
  }
  return out;
}
const real = () => Object.fromEntries(readdirSync(DIR).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(new URL(f, DIR), 'utf8')]));

it('every writer of topups.refunded_minor / package_orders.refunded_minor clamps with MIN(amount_minor, ...)', () => {
  const writers = scanWriters(real());
  expect(writers.length).toBeGreaterThanOrEqual(8); // card-refunds x4, package-orders x4 (a refactor that hides a writer from this scan must update it)
  expect(writers.filter((w) => w.endsWith('UNCLAMPED')), 'a refunded_minor writer without MIN(amount_minor, ...)').toEqual([]);
});

it('the scan itself catches an un-clamped writer (a mutation check that stays in the suite)', () => {
  expect(scanWriters({ 'x.ts': "UPDATE topups SET refunded_minor = refunded_minor + ? WHERE order_id = ?" })).toEqual(['x.ts: UNCLAMPED']);
  expect(scanWriters({ 'x.ts': "UPDATE package_orders SET status = ?, refunded_minor = MIN(amount_minor, refunded_minor + ?) WHERE order_id = ?" })).toEqual(['x.ts: clamped']);
  expect(scanWriters({ 'x.ts': "UPDATE topups SET state = 'expired' WHERE order_id = ?" })).toEqual([]);
});
