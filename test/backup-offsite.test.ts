import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signManifest } from '../src/core/backup';
// @ts-expect-error plain .mjs module, no types
import { canonical, sign } from '../scripts/verify-backup-manifest.mjs';

// T21 + M-174: the off-Cloudflare copy (snapshots AND bodies) and the offline manifest verifier. rclone is faked: the test proves WHAT the script asks for.
const ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(ROOT, 'scripts/verify-backup-manifest-cli.mjs');
const KEY = 'backup-hmac-key-for-tests-0123456789abcdef';
const SECRET_ENV = 'R2-SECRET-ACCESS-KEY-VALUE-123';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true }); } catch { /* already gone */ }; });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wa-offsite-')); dirs.push(d); return d; };

/** A PATH with a fake rclone that logs its arguments, one call per line. */
function fakeRclone() {
  const bin = tmp();
  const log = join(bin, 'calls.log');
  // `copy r2:ebda-wa-backups/... <dir>` materialises $FAKE_R2_BACKUPS there (what rclone would download); `copy <local> <dir>` copies the folder; `sync` and anything else only logs.
  writeFileSync(join(bin, 'rclone'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = copy ]; then case "$3" in *:*) exit 0;; esac; mkdir -p "$3"; case "$2" in r2:ebda-wa-backups*) [ -n "$FAKE_R2_BACKUPS" ] && cp -R "$FAKE_R2_BACKUPS/." "$3";; *) cp -R "$2/." "$3";; esac; fi\n`);
  chmodSync(join(bin, 'rclone'), 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}
const run = (script: string, args: string[], env: Record<string, string>, bin?: string) =>
  spawnSync('bash', [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: `${bin ?? ''}:${process.env.PATH}`, HOME: tmpdir(), ...env } });

/** A real snapshot folder: ndjson files + a manifest whose hashes and row counts are right; signed when `key` is given. */
async function snapshot(dir: string, key?: string) {
  mkdirSync(dir, { recursive: true });
  const bodies: Record<string, string> = { contacts: '{"id":1}\n', conversations: '', messages: '{"id":1}\n{"id":2}\n', message_status_events: '' };
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const [t, body] of Object.entries(bodies)) {
    writeFileSync(join(dir, `${t}.ndjson`), body);
    tables[t] = { rows: body.split('\n').filter(Boolean).length, sha256: createHash('sha256').update(body).digest('hex') };
  }
  const m = { workspaceId: dir.split('/').at(-2), date: dir.split('/').at(-1), schemaVersion: 36, tables } as never;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(key ? { ...(m as object), signature: await signManifest(m, key) } : m));
}

/** What rclone would download from R2: `<ws>/<date>/…` folders, signed with KEY unless told otherwise. */
async function r2Fixture(...snaps: { ws: string; date?: string; key?: string | null }[]) {
  const root = tmp();
  for (const x of snaps) await snapshot(join(root, x.ws, x.date ?? '2026-10-27'), x.key === null ? undefined : (x.key ?? KEY));
  return root;
}
const base = (fixture: string, dest: string, extra: Record<string, string> = {}) => ({ OFFSITE_DEST: dest, OFFSITE_STAGE: join(tmp(), 'stage'), FAKE_R2_BACKUPS: fixture, BACKUP_HMAC_KEY: KEY, ...extra });

describe('scripts/backup-offsite.sh', () => {
  it('refuses without a destination, and refuses the R2 account itself as the destination', () => {
    const f = fakeRclone();
    const a = run('scripts/backup-offsite.sh', ['2026-10-27'], {}, f.bin);
    expect(a.status).not.toBe(0);
    expect(a.stderr).toContain('OFFSITE_DEST');
    const b = run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: 'r2:somewhere' }, f.bin);
    expect(b.status).toBe(2);
    expect(f.calls()).toEqual([]);
  });

  it('stages and verifies the snapshots, copies only verified ones, mirrors bodies/ (with a backup dir for what a run removes), and puts no credential in any argument', async () => {
    const f = fakeRclone();
    const dest = tmp();
    const fixture = await r2Fixture({ ws: 'ws-a' }, { ws: 'ws-b' });
    const env = base(fixture, dest, { RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: SECRET_ENV });
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], env, f.bin);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls();
    const stage = env.OFFSITE_STAGE;
    expect(calls).toContain(`copy r2:ebda-wa-backups/backups ${stage}/snapshots --checksum --fast-list --include */2026-10-27/**`); // only TONIGHT's folders, never the whole bucket
    expect(calls).toContain(`copy ${stage}/verified ${dest}/snapshots/2026-10-27 --checksum`);
    expect(calls).toContain(`sync r2:ebda-wa-media/bodies ${dest}/bodies --checksum --fast-list --backup-dir ${dest}/bodies-removed/2026-10-27`);
    expect(calls.join('\n')).not.toContain(SECRET_ENV);
    expect(calls.join('\n')).not.toContain(KEY);
    expect(r.stdout + r.stderr).not.toContain(SECRET_ENV);
    expect(existsSync(join(dest, 'snapshots/2026-10-27/ws-a/2026-10-27/manifest.json'))).toBe(true);
    expect(r.stdout).toContain('2 snapshot(s) verified');
  });

  it('a tampered table, an unsigned manifest under a key, or a manifest of another workspace fails the run and NOTHING is copied off-site', async () => {
    for (const [label, fix] of [['tampered', async (root: string) => writeFileSync(join(root, 'ws-t/2026-10-27/messages.ndjson'), '{"id":1}\n{"id":3}\n')], ['unsigned', null]] as const) {
      const f = fakeRclone();
      const dest = tmp();
      const fixture = await r2Fixture({ ws: 'ws-t', key: label === 'unsigned' ? null : KEY });
      if (fix) await fix(fixture);
      const r = run('scripts/backup-offsite.sh', ['2026-10-27'], base(fixture, dest), f.bin);
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toContain('NOT VERIFIED');
      expect(f.calls().some((c) => c.startsWith(`copy`) && c.includes(dest)), label).toBe(false);
      expect(f.calls().some((c) => c.startsWith('sync')), label).toBe(false);
    }
  });

  it('a verifier that exits 0 but prints no VERIFIED line is NOT a pass: the job fails loudly (absence of an error is not success)', async () => {
    const f = fakeRclone();
    const bin = tmp();
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n'); // "verifies" by doing nothing, exactly what the old silent CLI did
    chmodSync(join(bin, 'node'), 0o755);
    const dest = tmp();
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], base(await r2Fixture({ ws: 'ws-q' }), dest), `${bin}:${f.bin}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NOT VERIFIED');
    expect(f.calls().some((c) => c.includes(`${dest}/snapshots`))).toBe(false);
  });

  it('a copy with no snapshot in it is a failure (an empty copy must not look like a verified one)', async () => {
    const f = fakeRclone();
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], base(await r2Fixture(), tmp()), f.bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no snapshot');
  });

  it('prunes only its own dated folders older than the window', async () => {
    const f = fakeRclone();
    const dest = tmp();
    for (const d of ['snapshots/2026-01-01', 'snapshots/2026-10-20', 'snapshots/keep-me']) mkdirSync(join(dest, d), { recursive: true });
    mkdirSync(join(dest, 'bodies-removed'), { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const d of ['snapshots/2026-01-01', 'snapshots/keep-me']) utimesSync(join(dest, d), old, old);
    expect(run('scripts/backup-offsite.sh', ['2026-10-27'], base(await r2Fixture({ ws: 'ws-p' }), dest), f.bin).status).toBe(0);
    expect(existsSync(join(dest, 'snapshots/2026-01-01'))).toBe(false);
    expect(existsSync(join(dest, 'snapshots/2026-10-20'))).toBe(true);
    expect(existsSync(join(dest, 'snapshots/keep-me'))).toBe(true); // not a dated folder of ours: never touched
  });
});

describe('scripts/backup-offsite.sh (final review I6)', () => {
  it('one bad snapshot does not block the rest: the good one is copied, the run exits non-zero with a summary', async () => {
    const f = fakeRclone();
    const dest = tmp();
    const fixture = await r2Fixture({ ws: 'ws-good' }, { ws: 'ws-bad' });
    writeFileSync(join(fixture, 'ws-bad/2026-10-27/messages.ndjson'), '{"id":1}\n{"id":3}\n');
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], base(fixture, dest), f.bin);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NOT VERIFIED');
    expect(r.stderr).toContain('1 of 2');
    expect(existsSync(join(dest, 'snapshots/2026-10-27/ws-good/2026-10-27/manifest.json'))).toBe(true);
    expect(existsSync(join(dest, 'snapshots/2026-10-27/ws-bad'))).toBe(false);
    expect(f.calls().some((c) => c.startsWith('sync'))).toBe(true); // the bodies mirror still ran
  });

  it('BACKUP_HMAC_KEY is required: without it nothing is asked of rclone', async () => {
    const f = fakeRclone();
    const env = base(await r2Fixture({ ws: 'ws-k' }), tmp());
    delete (env as Record<string, string | undefined>).BACKUP_HMAC_KEY;
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], env, f.bin);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BACKUP_HMAC_KEY');
    expect(f.calls()).toEqual([]);
  });

  it('an unsigned manifest fails, unless the snapshot is older than BACKUP_KEY_SINCE: then it is reported as legacy, skipped (not copied) and does not fail the job', async () => {
    const f = fakeRclone();
    const dest = tmp();
    const fixture = await r2Fixture({ ws: 'ws-old', key: null }, { ws: 'ws-new' });
    const noSince = run('scripts/backup-offsite.sh', ['2026-10-27'], base(fixture, dest), f.bin);
    expect(noSince.status).toBe(1);
    expect(noSince.stderr).toContain('not signed');
    const legacy = run('scripts/backup-offsite.sh', ['2026-10-27'], base(fixture, dest, { BACKUP_KEY_SINCE: '2026-11-01' }), f.bin);
    expect(legacy.status, legacy.stderr).toBe(0);
    expect(legacy.stdout).toContain('LEGACY-UNSIGNED');
    expect(legacy.stdout).toContain('1 legacy');
    expect(existsSync(join(dest, 'snapshots/2026-10-27/ws-new/2026-10-27/manifest.json'))).toBe(true);
    expect(existsSync(join(dest, 'snapshots/2026-10-27/ws-old'))).toBe(false);
    const afterSince = run('scripts/backup-offsite.sh', ['2026-10-27'], base(fixture, dest, { BACKUP_KEY_SINCE: '2026-10-01' }), f.bin);
    expect(afterSince.status).toBe(1); // signing was already required on that date
  });

  it('prunes an rclone REMOTE too: delete --min-age and rmdirs on snapshots and bodies-removed', async () => {
    const f = fakeRclone();
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], base(await r2Fixture({ ws: 'ws-r' }), 'b2:ebda-offsite', { OFFSITE_KEEP_DAYS: '30' }), f.bin);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls();
    for (const dir of ['snapshots', 'bodies-removed']) {
      expect(calls).toContain(`delete b2:ebda-offsite/${dir} --min-age 30d`);
      expect(calls).toContain(`rmdirs b2:ebda-offsite/${dir} --leave-root`);
    }
  });

  it('the CLI: unsigned + before the key date is LEGACY-UNSIGNED (exit 0); no key at all is NOT VERIFIED', async () => {
    const d = join(tmp(), 'ws-l', '2026-10-27');
    await snapshot(d);
    const node = (env: Record<string, string>) => spawnSync('node', [CLI, d], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    const legacy = node({ BACKUP_HMAC_KEY: KEY, BACKUP_KEY_SINCE: '2026-11-01' });
    expect(legacy.status).toBe(0);
    expect(legacy.stdout).toMatch(/^LEGACY-UNSIGNED ws-l 2026-10-27/m);
    expect(node({ BACKUP_HMAC_KEY: KEY }).status).toBe(1);
    const none = node({});
    expect(none.status).toBe(1);
    expect(none.stdout).toContain('BACKUP_HMAC_KEY is required');
  });
});

describe('scripts/verify-backup-manifest.mjs', () => {
  it('agrees with the Worker\'s signature byte for byte', async () => {
    const m = { workspaceId: 'ws', date: '2026-10-27', schemaVersion: 36, tables: { contacts: { rows: 1, sha256: 'a'.repeat(64) } } } as never;
    expect(sign(m, KEY)).toBe(await signManifest(m, KEY));
    expect(canonical({ b: 1, a: { d: 1, c: 2 }, signature: 'x' })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
  it('exit codes: 0 + a positive VERIFIED line, 1 not verified (wrong key; previous key accepted), 2 usage', async () => {
    const d = join(tmp(), 'ws-x', '2026-10-27');
    await snapshot(d, KEY);
    const node = (env: Record<string, string>, dir = d) => spawnSync('node', [CLI, dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    const ok = node({ BACKUP_HMAC_KEY: KEY });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^VERIFIED ws-x 2026-10-27 4 files/m);
    expect(node({ BACKUP_HMAC_KEY: 'x'.repeat(40) }).status).toBe(1);
    expect(node({ BACKUP_HMAC_KEY: 'x'.repeat(40), BACKUP_HMAC_KEY_PREVIOUS: KEY }).status).toBe(0);
    expect(node({}).status).toBe(1); // signed backup, nothing to check it with
    expect(spawnSync('node', [CLI], { encoding: 'utf8' }).status).toBe(2);
  });

  it('FAIL-OPEN guard: the CLI really runs from a path with a space, from a symlink and from a relative path, and a tampered manifest still exits 1 (the entry check used to be skipped silently)', async () => {
    const base = tmp();
    const spaced = join(base, 'my backups', 'ws-s', '2026-10-27');
    await snapshot(spaced, KEY);
    const link = join(base, 'link-to-cli.mjs');
    symlinkSync(CLI, link);
    const runVia = (cli: string, dir: string, cwd = ROOT) => spawnSync('node', [cli, dir], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', BACKUP_HMAC_KEY: KEY } });
    for (const r of [runVia(CLI, spaced), runVia(link, spaced), runVia(relative(ROOT, CLI), relative(ROOT, spaced))]) {
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^VERIFIED ws-s 2026-10-27/m);
    }
    writeFileSync(join(spaced, 'messages.ndjson'), '{"id":9}\n');
    for (const r of [runVia(CLI, spaced), runVia(link, spaced)]) {
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('NOT VERIFIED');
    }
  });

  it('a folder whose path does not name the manifest\'s workspace and date is not verified (a manifest moved into another folder)', async () => {
    const d = join(tmp(), 'ws-b', '2026-10-27');
    await snapshot(join(tmp(), 'ws-a', '2026-10-27'), KEY); // only to make sure helper works
    await snapshot(d, KEY);
    const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
    writeFileSync(join(d, 'manifest.json'), JSON.stringify({ ...m, workspaceId: 'ws-a', signature: await signManifest({ ...m, workspaceId: 'ws-a' }, KEY) })); // a genuine, signed manifest of ANOTHER workspace
    const r = spawnSync('node', [CLI, d], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', BACKUP_HMAC_KEY: KEY } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('another workspace or date');
  });
});
