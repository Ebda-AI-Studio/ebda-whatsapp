// Platform-global InstaPay duplicate index (money path): a receipt (reference OR image hash) is claimable ONCE across every merchant and
// every product. One shared D1 database is bound in each product; this file is the contract and the D1 implementation.
// Fail-closed: invalid keys throw (the caller treats a throw as "needs human"); a burned row blocks forever.
import { normalizeReference } from './instapay-extract';

export const normalizeReferenceKey = normalizeReference;

export type DedupeEntry = { referenceKey: string; imageSha256: string; product: 'store' | 'chat'; ownerId: string; paymentId: string };
export type ClaimResult = 'claimed' | 'ours' | 'duplicate_reference' | 'duplicate_image';
export type PeekResult = 'none' | 'reference' | 'image' | 'both';

export interface DuplicateIndex {
  claim(e: DedupeEntry): Promise<ClaimResult>;
  peek(referenceKey: string, imageSha256: string): Promise<PeekResult>;
  /** frees the rows this payment holds (only while `held`); a no-op for anyone else */
  release(e: DedupeEntry): Promise<void>;
  /** blocks both keys forever (revert, history backfill); creates the rows when absent */
  burn(e: DedupeEntry): Promise<void>;
}

export const DEDUPE_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS instapay_dedupe (
  kind TEXT NOT NULL CHECK (kind IN ('ref','img')),
  key TEXT NOT NULL,
  product TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payment_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','burned')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS instapay_dedupe_payment ON instapay_dedupe (payment_id);`;

const SHA_RE = /^[0-9a-f]{64}$/;
function check(e: Pick<DedupeEntry, 'referenceKey' | 'imageSha256'>): void {
  if (!/^\d{6,40}$/.test(e.referenceKey)) throw new Error('invalid reference key');
  if (!SHA_RE.test(e.imageSha256)) throw new Error('invalid image hash');
}
const peekOf = (ref: boolean, img: boolean): PeekResult => (ref && img ? 'both' : ref ? 'reference' : img ? 'image' : 'none');

type Row = { kind: 'ref' | 'img'; key: string; product: string; owner_id: string; payment_id: string; state: 'held' | 'burned' };
/** ownership is the whole tuple (product, owner, payment): a payment id alone is not an identity across products */
const sameOwner = (r: { product: string; owner_id: string; payment_id: string }, e: DedupeEntry) => r.product === e.product && r.owner_id === e.ownerId && r.payment_id === e.paymentId;

/** pure verdict from the two rows as they stand after our inserts; `inserted` = how many of OUR inserts landed this call */
function verdict(e: DedupeEntry, ref: Row | undefined, img: Row | undefined, inserted: number): ClaimResult {
  const mine = (r: Row | undefined) => !!r && sameOwner(r, e) && r.state === 'held';
  if (mine(ref) && mine(img)) return inserted > 0 ? 'claimed' : 'ours';
  return !mine(ref) ? 'duplicate_reference' : 'duplicate_image';
}

export class MemoryDuplicateIndex implements DuplicateIndex {
  private rows = new Map<string, Row>();
  private k = (kind: string, key: string) => `${kind}:${key}`;
  async claim(e: DedupeEntry): Promise<ClaimResult> {
    check(e);
    let inserted = 0;
    const mine: string[] = [];
    for (const [kind, key] of [['ref', e.referenceKey], ['img', e.imageSha256]] as const) {
      const id = this.k(kind, key);
      if (!this.rows.has(id)) {
        this.rows.set(id, { kind, key, payment_id: e.paymentId, state: 'held', product: e.product, owner_id: e.ownerId });
        inserted++;
        mine.push(id);
      }
    }
    const v = verdict(e, this.rows.get(this.k('ref', e.referenceKey)), this.rows.get(this.k('img', e.imageSha256)), inserted);
    if (v === 'duplicate_reference' || v === 'duplicate_image') for (const id of mine) this.rows.delete(id);
    return v;
  }
  async peek(referenceKey: string, imageSha256: string): Promise<PeekResult> {
    check({ referenceKey, imageSha256 });
    return peekOf(this.rows.has(this.k('ref', referenceKey)), this.rows.has(this.k('img', imageSha256)));
  }
  async release(e: DedupeEntry): Promise<void> {
    check(e);
    for (const [kind, key] of [['ref', e.referenceKey], ['img', e.imageSha256]] as const) {
      const r = this.rows.get(this.k(kind, key));
      if (r && sameOwner(r, e) && r.state === 'held') this.rows.delete(this.k(kind, key));
    }
  }
  async burn(e: DedupeEntry): Promise<void> {
    check(e);
    for (const [kind, key] of [['ref', e.referenceKey], ['img', e.imageSha256]] as const) {
      const r = this.rows.get(this.k(kind, key));
      if (!r) this.rows.set(this.k(kind, key), { kind, key, payment_id: e.paymentId, state: 'burned', product: e.product, owner_id: e.ownerId });
      else if (sameOwner(r, e)) r.state = 'burned';
    }
  }
}

// Structural D1 types so this file imports nothing from the Workers types package.
// pq-allow(unused-export): structural type a consumer's D1 binding satisfies (half of the D1Like contract)
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<Array<{ meta?: { changes?: number } }>>;
}

export class D1DuplicateIndex implements DuplicateIndex {
  constructor(private db: D1Like, private now: () => number = Date.now) {}

  private insert(kind: 'ref' | 'img', key: string, e: DedupeEntry, state: 'held' | 'burned'): D1StatementLike {
    return this.db
      .prepare('INSERT OR IGNORE INTO instapay_dedupe (kind, key, product, owner_id, payment_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(kind, key, e.product, e.ownerId, e.paymentId, state, this.now());
  }
  private async read(referenceKey: string, imageSha256: string): Promise<{ ref?: Row; img?: Row }> {
    const { results } = await this.db
      .prepare("SELECT kind, key, product, owner_id, payment_id, state FROM instapay_dedupe WHERE (kind = 'ref' AND key = ?) OR (kind = 'img' AND key = ?)")
      .bind(referenceKey, imageSha256)
      .all<Row>();
    const rows = results ?? [];
    return { ref: rows.find((r) => r.kind === 'ref'), img: rows.find((r) => r.kind === 'img') };
  }

  async claim(e: DedupeEntry): Promise<ClaimResult> {
    check(e);
    // both rows in ONE batch (a transaction); INSERT OR IGNORE never errors, so `changes` says which of OUR inserts landed
    const res = await this.db.batch([this.insert('ref', e.referenceKey, e, 'held'), this.insert('img', e.imageSha256, e, 'held')]);
    const landed = [(res[0]?.meta?.changes ?? 0) > 0, (res[1]?.meta?.changes ?? 0) > 0];
    const { ref, img } = await this.read(e.referenceKey, e.imageSha256);
    const v = verdict(e, ref, img, landed.filter(Boolean).length);
    if (v === 'duplicate_reference' || v === 'duplicate_image') {
      // compensate: remove only what THIS call inserted (still held and ours) so a hit on either key leaves neither half-claimed
      const undo: D1StatementLike[] = [];
      if (landed[0]) undo.push(this.db.prepare("DELETE FROM instapay_dedupe WHERE kind = 'ref' AND key = ? AND product = ? AND owner_id = ? AND payment_id = ? AND state = 'held'").bind(e.referenceKey, e.product, e.ownerId, e.paymentId));
      if (landed[1]) undo.push(this.db.prepare("DELETE FROM instapay_dedupe WHERE kind = 'img' AND key = ? AND product = ? AND owner_id = ? AND payment_id = ? AND state = 'held'").bind(e.imageSha256, e.product, e.ownerId, e.paymentId));
      if (undo.length) await this.db.batch(undo);
    }
    return v;
  }
  async peek(referenceKey: string, imageSha256: string): Promise<PeekResult> {
    check({ referenceKey, imageSha256 });
    const { ref, img } = await this.read(referenceKey, imageSha256);
    return peekOf(!!ref, !!img);
  }
  async release(e: DedupeEntry): Promise<void> {
    check(e);
    await this.db.batch([
      this.db.prepare("DELETE FROM instapay_dedupe WHERE kind = 'ref' AND key = ? AND product = ? AND owner_id = ? AND payment_id = ? AND state = 'held'").bind(e.referenceKey, e.product, e.ownerId, e.paymentId),
      this.db.prepare("DELETE FROM instapay_dedupe WHERE kind = 'img' AND key = ? AND product = ? AND owner_id = ? AND payment_id = ? AND state = 'held'").bind(e.imageSha256, e.product, e.ownerId, e.paymentId),
    ]);
  }
  async burn(e: DedupeEntry): Promise<void> {
    check(e);
    await this.db.batch([
      this.insert('ref', e.referenceKey, e, 'burned'),
      this.insert('img', e.imageSha256, e, 'burned'),
      this.db.prepare("UPDATE instapay_dedupe SET state = 'burned' WHERE product = ? AND owner_id = ? AND payment_id = ? AND ((kind = 'ref' AND key = ?) OR (kind = 'img' AND key = ?))").bind(e.product, e.ownerId, e.paymentId, e.referenceKey, e.imageSha256),
    ]);
  }
}

type It = (name: string, fn: () => Promise<void> | void) => void;
type Expect = (actual: unknown) => { toBe(x: unknown): void; toEqual(x: unknown): void; rejects: { toThrow(): Promise<void> } };

/** The behaviour every DuplicateIndex must have. Each product runs it against its REAL D1 binding; foundation runs it on Memory and on a real SQLite. */
export function duplicateIndexContract(make: () => Promise<DuplicateIndex>, t: { it: It; expect: Expect }): void {
  const { it, expect } = t;
  const sha = (c: string) => c.repeat(64).slice(0, 64);
  const E = (over: Partial<DedupeEntry> = {}): DedupeEntry => ({ referenceKey: '123456789012', imageSha256: sha('a'), product: 'store', ownerId: 'o1', paymentId: 'p1', ...over });
  it('claim then re-claim by the same payment is idempotent', async () => {
    const d = await make();
    expect(await d.claim(E())).toBe('claimed');
    expect(await d.claim(E())).toBe('ours');
  });
  it('another payment with the same reference or image is a duplicate; both -> reference', async () => {
    const d = await make();
    await d.claim(E());
    expect(await d.claim(E({ paymentId: 'p2', imageSha256: sha('b') }))).toBe('duplicate_reference');
    expect(await d.claim(E({ paymentId: 'p3', referenceKey: '999999999999' }))).toBe('duplicate_image');
    expect(await d.claim(E({ paymentId: 'p4', product: 'chat' }))).toBe('duplicate_reference');
  });
  it('a lost claim leaves no orphan half', async () => {
    const d = await make();
    await d.claim(E());
    await d.claim(E({ paymentId: 'p2', imageSha256: sha('b') })); // loses on reference
    expect(await d.peek('555555555555', sha('b'))).toBe('none');
    await d.claim(E({ paymentId: 'p3', referenceKey: '777777777777' })); // loses on image
    expect(await d.peek('777777777777', sha('c'))).toBe('none');
  });
  it('release frees only the owner, only while held', async () => {
    const d = await make();
    await d.claim(E());
    await d.release(E({ paymentId: 'other' }));
    expect(await d.peek(E().referenceKey, E().imageSha256)).toBe('both');
    await d.release(E());
    expect(await d.peek(E().referenceKey, E().imageSha256)).toBe('none');
    expect(await d.claim(E({ paymentId: 'p2' }))).toBe('claimed');
  });
  it('burn blocks forever: release does nothing and even the same payment cannot re-claim', async () => {
    const d = await make();
    await d.claim(E());
    await d.burn(E());
    await d.release(E());
    expect(await d.peek(E().referenceKey, E().imageSha256)).toBe('both');
    expect(await d.claim(E())).toBe('duplicate_reference');
    expect(await d.claim(E({ paymentId: 'p2' }))).toBe('duplicate_reference');
  });
  it('burn creates the rows when none exist (history backfill)', async () => {
    const d = await make();
    await d.burn(E({ paymentId: 'old' }));
    expect(await d.claim(E())).toBe('duplicate_reference');
  });
  it('ownership is (product, owner, payment): the same payment id from another product or owner is a duplicate, never "ours" (review M3)', async () => {
    const d = await make();
    expect(await d.claim(E({ product: 'chat', ownerId: 'o1', paymentId: 'X' }))).toBe('claimed');
    expect(await d.claim(E({ product: 'store', ownerId: 'o1', paymentId: 'X' }))).toBe('duplicate_reference');
    expect(await d.claim(E({ product: 'chat', ownerId: 'other', paymentId: 'X' }))).toBe('duplicate_reference');
    expect(await d.claim(E({ product: 'chat', ownerId: 'o1', paymentId: 'X' }))).toBe('ours');
  });
  it('release and burn by a same-id payment of another product or owner change nothing', async () => {
    const d = await make();
    await d.claim(E({ product: 'chat', ownerId: 'o1', paymentId: 'X' }));
    await d.release(E({ product: 'store', ownerId: 'o1', paymentId: 'X' }));
    await d.release(E({ product: 'chat', ownerId: 'other', paymentId: 'X' }));
    expect(await d.peek(E().referenceKey, E().imageSha256)).toBe('both');
    await d.burn(E({ product: 'store', ownerId: 'o1', paymentId: 'X' }));
    expect(await d.claim(E({ product: 'chat', ownerId: 'o1', paymentId: 'X' }))).toBe('ours'); // still held (not burned) for its real owner
    await d.release(E({ product: 'chat', ownerId: 'o1', paymentId: 'X' }));
    expect(await d.peek(E().referenceKey, E().imageSha256)).toBe('none');
  });
  it('20 concurrent claims of one reference: exactly one wins', async () => {
    const d = await make();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, n) => d.claim(E({ paymentId: `c${n}`, imageSha256: sha(n.toString(16).padStart(1, '0')[0]!) }))));
    expect(rs.filter((r) => r === 'claimed').length).toBe(1);
  });
  it('invalid keys throw (fail closed)', async () => {
    const d = await make();
    await expect(d.claim(E({ referenceKey: '12' }))).rejects.toThrow();
    await expect(d.claim(E({ imageSha256: 'zz' }))).rejects.toThrow();
  });
}
