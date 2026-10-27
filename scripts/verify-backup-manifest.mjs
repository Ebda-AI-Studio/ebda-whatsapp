// The verification LIBRARY for a backup folder (M-174). The command line is scripts/verify-backup-manifest-cli.mjs, a separate file that always runs:
// an "am I the entry point" check inside this module is false for a path with a space, a symlink or a relative argv, and the CLI then silently did nothing and exited 0.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v);
/** MUST stay identical to canonicalManifest in src/core/backup.ts (test/backup-offsite.test.ts proves the two agree). */
export const canonical = (m) => { const { signature: _s, ...rest } = m; return JSON.stringify(sort(rest)); };
export const sign = (m, key) => `hmac-sha256:${createHmac('sha256', key).update(canonical(m)).digest('hex')}`;

/** Verifies a folder shaped `.../<workspaceId>/<date>/` (the layout of R2 and of every copy). Returns { ok: true, workspaceId, date, files, signed } or { ok: false, reason }. */
export function verifyFolder(dir, keys) {
  const abs = resolve(dir);
  const path = join(abs, 'manifest.json');
  if (!existsSync(path)) return { ok: false, reason: 'manifest.json not found' };
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); } catch { return { ok: false, reason: 'manifest.json is not JSON' }; }
  if (keys.length) {
    if (!m.signature) return { ok: false, reason: 'manifest is not signed' };
    const want = Buffer.from(String(m.signature));
    const good = keys.some((k) => { const got = Buffer.from(sign(m, k)); return got.length === want.length && timingSafeEqual(got, want); });
    if (!good) return { ok: false, reason: 'manifest signature invalid' };
  } else if (m.signature) {
    return { ok: false, reason: 'manifest is signed but BACKUP_HMAC_KEY is not set' };
  }
  // A genuine manifest of another workspace or date, placed in this folder, is not this folder's backup.
  if (typeof m.workspaceId !== 'string' || typeof m.date !== 'string' || basename(abs) !== m.date || basename(dirname(abs)) !== m.workspaceId) {
    return { ok: false, reason: 'manifest is for another workspace or date than this folder' };
  }
  let files = 0;
  for (const [table, entry] of Object.entries(m.tables ?? {})) {
    const file = join(abs, `${table}.ndjson`);
    if (!existsSync(file)) return { ok: false, reason: `missing file: ${table}` };
    const body = readFileSync(file, 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== entry.sha256) return { ok: false, reason: `checksum mismatch: ${table}` };
    if (body.split('\n').filter(Boolean).length !== entry.rows) return { ok: false, reason: `row count mismatch: ${table}` };
    files++;
  }
  if (files === 0) return { ok: false, reason: 'manifest lists no tables' };
  return { ok: true, workspaceId: m.workspaceId, date: m.date, files, signed: !!m.signature };
}
