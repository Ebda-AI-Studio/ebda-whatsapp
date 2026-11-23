import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Defect class (Ebda Store PR #791): on Cloudflare D1 `meta.changes` INCLUDES rows written by triggers, so an exact-one test
// (`changes === 1`) used as "I won the claim" makes every claimant lose the moment a table gains a row-writing trigger.
// Today every D1 trigger here is `BEFORE ... RAISE(ABORT)` (writes nothing), so the reviewed exact-one claims are correct.
// This guard keeps it that way: (1) no migration may add a trigger that writes rows, (2) no NEW exact-one comparison on a write
// result. Win test for a new single-row claim = `meta.changes > 0`. Escape: `// d1-exact-ok: <why>` on the same or previous line.
const ROOT = resolve(__dirname, '..');
const EXACT = /\b(?:changes|rowsAffected|changedRows)\b[^;\n]*?(===|!==|==|!=)\s*1(?![0-9.])/;
const SKIP = /\.(test|spec)\.|\.d\.ts$/;
const BASELINE: Record<string, number> = {
  "src/core/billing/topups.ts": 1,
  "src/core/billing/card-refunds.ts": 6,
  "src/core/billing/confirmation.ts": 1,
  "src/core/billing/funding.ts": 1,
  "src/core/billing/credit-packs.ts": 1,
  "src/core/billing/yearly-refund-request.ts": 1,
  "src/core/billing/operator.ts": 1
};

function scan(files: string[], read: (f: string) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      if (!EXACT.test(l.replace(/\/\/.*$/, ''))) return;
      if (/d1-exact-ok:/.test(l) || /d1-exact-ok:/.test(lines[i - 1] ?? '')) return;
      out[f] = (out[f] ?? 0) + 1;
    });
  }
  return out;
}

const tracked = (dir: string, ext: string): string[] =>
  readdirSync(resolve(ROOT, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) return tracked(rel, ext);
    return rel.endsWith(ext) && !SKIP.test(rel) ? [rel] : [];
  });

it('flags a new exact-one comparison on a write result', () => {
  const fake: Record<string, string> = { 'a.ts': 'if (r.meta.changes === 1) win();\nif (r.meta.changes !== 1) lose();\n// d1-exact-ok: unique key\nif (x.meta.changes === 1) ok();\nif (r.meta.changes > 0) ok();' };
  expect(scan(['a.ts'], (f) => fake[f]!)).toEqual({ 'a.ts': 2 });
});

it('no file gains an exact-one write-count comparison over the reviewed baseline', () => {
  const found = scan(tracked('src', '.ts'), (f) => readFileSync(resolve(ROOT, f), 'utf8'));
  const over = Object.entries(found).filter(([f, n]) => n > (BASELINE[f] ?? 0));
  expect(over, 'use `meta.changes > 0` for a single-row claim, or annotate `// d1-exact-ok: <reason>`').toEqual([]);
});

it('every D1 trigger is BEFORE ... RAISE (writes no row), so meta.changes stays the statement row count', () => {
  const sql = [...tracked('migrations', '.sql'), 'src/core/do-migrations.ts', 'src/core/ops/audit-retention.ts']
    .map((f) => readFileSync(resolve(ROOT, f), 'utf8')).join('\n');
  const triggers = sql.match(/CREATE TRIGGER[\s\S]*?;\s*END\b/gi) ?? [];
  expect(triggers.length).toBeGreaterThan(10);
  const writers = triggers.filter((t) => !/^CREATE TRIGGER \w+ BEFORE (UPDATE|DELETE|INSERT)\b[\s\S]*BEGIN\s+SELECT RAISE\(ABORT/i.test(t.replace(/\s+/g, ' ')) || /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/i.test(t.replace(/^CREATE TRIGGER[^]*?BEGIN/i, '')));
  expect(writers, 'a row-writing trigger breaks every `meta.changes === 1` claim: audit them before adding it').toEqual([]);
});
