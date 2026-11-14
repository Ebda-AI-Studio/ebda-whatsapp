// MANAGED FILE: vendored from ebda-foundation by `ebda-foundation sync`. Never edit it in a consumer; change `parity/` in the foundation repo.
// The same file runs in every Ebda product and proves its vendored copy of @ebda/foundation is the tagged one and behaves like the shared vectors.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

function findRoot(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(d, 'foundation.lock.json'))) return d;
    const up = dirname(d);
    if (up === d) throw new Error('foundation.lock.json not found above the parity test');
    d = up;
  }
}
const ROOT = findRoot();
const lock = JSON.parse(readFileSync(join(ROOT, 'foundation.lock.json'), 'utf8')) as { tag: string; commit: string; dir: string; parity: string; files: Record<string, string> };
const sha = (p: string) => createHash('sha256').update(readFileSync(join(ROOT, p))).digest('hex');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const vector = (name: string) => JSON.parse(readFileSync(join(ROOT, lock.dir, 'vectors', name), 'utf8'));
const load = (mod: string) => import(/* @vite-ignore */ pathToFileURL(join(ROOT, lock.dir, `${mod}.ts`)).href);

describe('foundation lock', () => {
  it('every locked file exists and has the locked sha256', () => {
    for (const [p, want] of Object.entries(lock.files)) {
      expect(existsSync(join(ROOT, p)), `missing ${p}`).toBe(true);
      expect(sha(p), `modified ${p}`).toBe(want);
    }
  });
  it('no extra files under the vendored dir', () => {
    const extra = walk(join(ROOT, lock.dir)).map((f) => relative(ROOT, f).split(sep).join('/')).filter((p) => !(p in lock.files));
    expect(extra).toEqual([]);
  });
  it('lock tag and commit match the vendored package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, lock.dir, 'package.json'), 'utf8')) as { version: string; foundationCommit: string };
    expect(lock.tag).toBe(`v${pkg.version}`);
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(pkg.foundationCommit).toBe(lock.commit);
  });
  it("the vendored package's peer dependencies are declared by the product's package.json at the exact version", () => {
    const vendored = JSON.parse(readFileSync(join(ROOT, lock.dir, 'package.json'), 'utf8')) as { peerDependencies?: Record<string, string> };
    const own = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const have = { ...own.peerDependencies, ...own.devDependencies, ...own.dependencies };
    for (const [name, want] of Object.entries(vendored.peerDependencies ?? {})) expect(have[name], `add ${name}@${want} to package.json`).toBe(want);
  });
  it('the parity test itself is the locked one', () => {
    expect(lock.parity in lock.files).toBe(true);
  });
});

describe('shared vectors against the vendored code', () => {
  it('phone: every case', async () => {
    const { normaliseE164 } = await load('phone');
    const cases = vector('phone.json') as Array<{ in: string; e164: string | null }>;
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const c of cases) expect(normaliseE164(c.in), c.in).toBe(c.e164);
  });
  it('buyerKey: fixed secret, 8 numbers, exact hex', async () => {
    const { buyerKey } = await load('buyer');
    const v = vector('buyer-key.json') as { secret: string; cases: Array<{ e164: string; hex: string }> };
    expect(v.cases).toHaveLength(8);
    for (const c of v.cases) expect(await buyerKey(v.secret, c.e164)).toBe(c.hex);
  });
  it('buyerKeyProbe: the /health probe vector', async () => {
    const { buyerKeyProbe } = await load('buyer');
    const v = vector('buyer-key-probe.json') as { secret: string; vector: string };
    expect(await buyerKeyProbe(v.secret)).toBe(v.vector);
  });
  it('arabic: foldArabic on every row', async () => {
    const { foldArabic } = await load('text');
    const v = vector('arabic.json') as { cases: Array<{ in: string; out: string }> };
    expect(v.cases.length).toBeGreaterThanOrEqual(35);
    for (const c of v.cases) expect(foldArabic(c.in), JSON.stringify(c.in)).toBe(c.out);
  });
  it('slugs: format, reserved and demo-showroom vectors', async () => {
    const { slugFormatError, isReservedSlug, isDemoShowroomSlug } = await load('slugs');
    const v = vector('slugs.json');
    for (const c of v.format) expect(slugFormatError(c.in), c.in).toBe(c.error);
    for (const s of v.reserved.yes) expect(isReservedSlug(s), s).toBe(true);
    for (const s of v.reserved.no) expect(isReservedSlug(s), s).toBe(false);
    for (const s of v.demoShowroom.yes) expect(isDemoShowroomSlug(s), s).toBe(true);
    for (const s of v.demoShowroom.no) expect(isDemoShowroomSlug(s), s).toBe(false);
  });
});
