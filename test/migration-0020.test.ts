import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

/**
 * Deploy safety of 0020: it adds `bank_ref` as a NEW column and a PARTIAL unique index over it (WHERE bank_ref IS NOT NULL), so rows that exist in production (all NULL) can never
 * make the index fail to build. A node-project test: it replays the real migrations into an in-memory SQLite.
 */
const DIR = new URL('../migrations/d1/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const apply = (db: DatabaseSync, upTo: (f: string) => boolean) => { for (const f of files) if (upTo(f)) db.exec(readFileSync(new URL(f, DIR), 'utf8')); };

it('applies on top of production-shaped data: old InstaPay rows (even ones that look alike) never collide; afterwards a duplicate normalised reference is refused by the index', () => {
  const db = new DatabaseSync(':memory:');
  apply(db, (f) => f < '0020');
  db.exec("INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'w1', 1), ('w2', 'w2', 1)");
  for (const [id, ref, ws] of [['old-1', 'WA-AAAAAAA1', 'w1'], ['old-2', 'WA-AAAAAAA2', 'w2']] as const) {
    db.prepare("INSERT INTO instapay_requests (id, reference, workspace_id, kind, amount_minor, state, created_by, created_at, expires_at, proof_key) VALUES (?, ?, ?, 'topup', 1000, 'confirmed', 'm', 1, 2, 'same/raw/ref.png')").run(id, ref, ws); // the same raw value in two old rows
  }
  expect(() => apply(db, (f) => f >= '0020' && f < '0021')).not.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM instapay_requests WHERE bank_ref IS NULL').get()).toEqual({ n: 2 });
  db.prepare("UPDATE instapay_requests SET bank_ref = 'IP123456' WHERE id = 'old-1'").run();
  expect(() => db.prepare("UPDATE instapay_requests SET bank_ref = 'IP123456' WHERE id = 'old-2'").run()).toThrow(/UNIQUE/); // the backstop works; the code checks first
  db.prepare("UPDATE instapay_requests SET bank_ref = NULL WHERE id = 'old-1'").run();
  db.prepare("UPDATE instapay_requests SET bank_ref = 'IP123456' WHERE id = 'old-2'").run();
});

it('the unique index is partial over the NEW column only', () => {
  const sql = readFileSync(new URL('0020_instapay_duplicates.sql', DIR), 'utf8');
  expect(sql).toMatch(/ADD COLUMN bank_ref TEXT/);
  expect(sql).toMatch(/CREATE UNIQUE INDEX instapay_requests_bank_ref ON instapay_requests \(bank_ref\) WHERE bank_ref IS NOT NULL/);
});
