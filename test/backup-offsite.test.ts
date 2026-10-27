import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signManifest } from '../src/core/backup';
// @ts-expect-error plain .mjs script, no types
import { canonical, sign } from '../scripts/verify-backup-manifest.mjs';

// T21 + M-174: the off-Cloudflare copy (snapshots AND bodies) and the offline manifest verifier. rclone is faked: the test proves WHAT the script asks for.
const ROOT = new URL('..', import.meta.url).pathname;
const KEY = 'backup-hmac-key-for-tests-0123456789abcdef';
const SECRET_ENV = 'R2-SECRET-ACCESS-KEY-VALUE-123';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wa-offsite-')); dirs.push(d); return d; };

/** A PATH with a fake rclone that logs its arguments, one call per line. */
function fakeRclone() {
  const bin = tmp();
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'rclone'), `#!/bin/sh\necho "$@" >> "${log}"\n`);
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
  const m = { workspaceId: 'ws', date: '2026-10-27', schemaVersion: 36, tables } as never;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(key ? { ...(m as object), signature: await signManifest(m, key) } : m));
}

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

  it('copies the dated snapshots AND mirrors bodies/ (with a backup dir for what a run removes), and puts no credential in any argument', async () => {
    const f = fakeRclone();
    const dest = tmp();
    const r = run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: dest, BACKUP_HMAC_KEY: KEY, RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: SECRET_ENV }, f.bin);
    expect(r.status, r.stderr).toBe(0);
    const calls = f.calls();
    expect(calls).toContain(`copy r2:ebda-wa-backups/backups ${dest}/snapshots/2026-10-27 --checksum --fast-list`);
    expect(calls).toContain(`sync r2:ebda-wa-media/bodies ${dest}/bodies --checksum --fast-list --backup-dir ${dest}/bodies-removed/2026-10-27`);
    expect(calls.join('\n')).not.toContain(SECRET_ENV);
    expect(calls.join('\n')).not.toContain(KEY);
    expect(r.stdout + r.stderr).not.toContain(SECRET_ENV);
  });

  it('verifies every copied snapshot: a good signed one passes; a tampered table or a missing signature fails the run', async () => {
    const f = fakeRclone();
    const dest = tmp();
    await snapshot(join(dest, 'snapshots/2026-10-27/ws-good'), KEY);
    expect(run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: dest, BACKUP_HMAC_KEY: KEY }, f.bin).status).toBe(0);
    writeFileSync(join(dest, 'snapshots/2026-10-27/ws-good/messages.ndjson'), '{"id":1}\n{"id":3}\n');
    const bad = run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: dest, BACKUP_HMAC_KEY: KEY }, f.bin);
    expect(bad.status).toBe(1);
    expect(bad.stderr + bad.stdout).toContain('NOT VERIFIED');
    const dest2 = tmp();
    await snapshot(join(dest2, 'snapshots/2026-10-27/ws-unsigned'));
    expect(run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: dest2, BACKUP_HMAC_KEY: KEY }, f.bin).status).toBe(1); // a key is configured: unsigned is refused
  });

  it('prunes only its own dated folders older than the window', () => {
    const f = fakeRclone();
    const dest = tmp();
    for (const d of ['snapshots/2026-01-01', 'snapshots/2026-10-20', 'snapshots/keep-me']) mkdirSync(join(dest, d), { recursive: true });
    mkdirSync(join(dest, 'bodies-removed'), { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    for (const d of ['snapshots/2026-01-01', 'snapshots/keep-me']) utimesSync(join(dest, d), old, old);
    expect(run('scripts/backup-offsite.sh', ['2026-10-27'], { OFFSITE_DEST: dest }, f.bin).status).toBe(0);
    expect(existsSync(join(dest, 'snapshots/2026-01-01'))).toBe(false);
    expect(existsSync(join(dest, 'snapshots/2026-10-20'))).toBe(true);
    expect(existsSync(join(dest, 'snapshots/keep-me'))).toBe(true); // not a dated folder of ours: never touched
  });
});

describe('scripts/verify-backup-manifest.mjs', () => {
  it('agrees with the Worker\'s signature byte for byte', async () => {
    const m = { workspaceId: 'ws', date: '2026-10-27', schemaVersion: 36, tables: { contacts: { rows: 1, sha256: 'a'.repeat(64) } } } as never;
    expect(sign(m, KEY)).toBe(await signManifest(m, KEY));
    expect(canonical({ b: 1, a: { d: 1, c: 2 }, signature: 'x' })).toBe('{"a":{"c":2,"d":1},"b":1}');
  });
  it('exit codes: 0 verified, 1 not verified (wrong key, previous key accepted), 2 usage', async () => {
    const d = tmp();
    await snapshot(d, KEY);
    const v = (env: Record<string, string>) => run('scripts/verify-backup-manifest.mjs', [d], env).status;
    // the script is node, not bash: call it directly
    const node = (env: Record<string, string>) => spawnSync('node', [join(ROOT, 'scripts/verify-backup-manifest.mjs'), d], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
    void v;
    expect(node({ BACKUP_HMAC_KEY: KEY }).status).toBe(0);
    expect(node({ BACKUP_HMAC_KEY: 'x'.repeat(40) }).status).toBe(1);
    expect(node({ BACKUP_HMAC_KEY: 'x'.repeat(40), BACKUP_HMAC_KEY_PREVIOUS: KEY }).status).toBe(0);
    expect(node({}).status).toBe(1); // signed backup, nothing to check it with
    expect(spawnSync('node', [join(ROOT, 'scripts/verify-backup-manifest.mjs')], { encoding: 'utf8' }).status).toBe(2);
  });
});
