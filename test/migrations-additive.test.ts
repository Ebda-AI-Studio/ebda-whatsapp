import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DO_MIGRATIONS } from '../src/core/do-migrations';
import { destructiveStatements } from './helpers/additive';

// Rollback safety (W1-DEPLOY, audit M-098): migrations are forward-only, so a Worker rolled back to the previous version runs against the NEWER schema.
// That is only safe if every migration is ADDITIVE: the old code never finds a table, column or index it relies on gone or renamed.
// A genuinely destructive step needs an entry in ALLOWED below with a reason (and a human decision).
const ALLOWED: { where: string; reason: string }[] = [
  // Asked for by the controller with the A27 follow-up (wa#92 review): the fold needs the mixed-case twin deleted once its lower-case copy exists. A Worker rolled back across it reads lower-case tags, which it already writes.
  { where: 'DO v48: DELETE FROM conversation_tags WHERE tag <> lower(trim(tag))', reason: 'folds mixed-case conversation tags into their lower-case twin; no conversation link is lost (the INSERT OR IGNORE before it keeps it)' },
];

it('the checker flags what rollback cannot survive and passes what it can (fixtures)', () => {
  for (const bad of [
    'DROP TABLE contacts;', 'drop table if exists x', 'ALTER TABLE t DROP COLUMN c', 'ALTER TABLE t RENAME TO u', 'ALTER TABLE t RENAME COLUMN a TO b',
    'ALTER TABLE t ALTER COLUMN a SET NOT NULL', 'DROP INDEX i', 'DROP TRIGGER tr', 'DROP VIEW v', 'DELETE FROM contacts', 'TRUNCATE TABLE t', 'PRAGMA writable_schema = 1',
  ]) expect(destructiveStatements(bad), bad).not.toEqual([]);
  for (const ok of [
    'CREATE TABLE t (id INTEGER PRIMARY KEY)', 'ALTER TABLE t ADD COLUMN c TEXT', 'CREATE INDEX i ON t (c)', "INSERT OR IGNORE INTO packages (id) VALUES ('x')",
    "UPDATE packages SET max_members = 2 WHERE id = 'store-included'", 'CREATE VIRTUAL TABLE f USING fts5(name)', "-- we never DROP TABLE here\nCREATE TABLE t2 (id INTEGER)",
  ]) expect(destructiveStatements(ok), ok).toEqual([]);
});

it('every Durable Object migration is additive', () => {
  expect(DO_MIGRATIONS.length).toBeGreaterThan(20);
  const bad = DO_MIGRATIONS.flatMap((sql, i) => destructiveStatements(sql).map((s) => `DO v${i + 1}: ${s}`)).filter((b) => !ALLOWED.some((a) => b.startsWith(a.where)));
  expect(bad, 'destructive DO migration (rollback would break); make it additive or add an ALLOWED entry with a reason').toEqual([]);
});

it('every D1 migration is additive', () => {
  const dir = new URL('../migrations/d1/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  expect(files.length).toBeGreaterThan(10);
  const bad = files.flatMap((f) => destructiveStatements(readFileSync(new URL(f, dir), 'utf8')).map((s) => `${f}: ${s}`)).filter((b) => !ALLOWED.some((a) => b.startsWith(a.where)));
  expect(bad, 'destructive D1 migration (rollback would break); make it additive or add an ALLOWED entry with a reason').toEqual([]);
});
