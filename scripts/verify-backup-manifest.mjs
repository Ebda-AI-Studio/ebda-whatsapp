#!/usr/bin/env node
// Verifies ONE workspace backup folder offline: every table file against the manifest (row count + sha256) and the manifest's HMAC signature (M-174).
// Usage: BACKUP_HMAC_KEY=... [BACKUP_HMAC_KEY_PREVIOUS=...] node scripts/verify-backup-manifest.mjs <folder containing manifest.json and the .ndjson files>
// Exit 0 = verified, 1 = NOT verified (the reason is printed), 2 = usage. The key comes from the environment only, never from argv.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v);
/** MUST stay identical to canonicalManifest in src/core/backup.ts (test/backup-offsite.test.ts proves the two agree). */
export const canonical = (m) => { const { signature: _s, ...rest } = m; return JSON.stringify(sort(rest)); };
export const sign = (m, key) => `hmac-sha256:${createHmac('sha256', key).update(canonical(m)).digest('hex')}`;

export function verifyFolder(dir, keys) {
  const path = join(dir, 'manifest.json');
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
  for (const [table, entry] of Object.entries(m.tables ?? {})) {
    const file = join(dir, `${table}.ndjson`);
    if (!existsSync(file)) return { ok: false, reason: `missing file: ${table}` };
    const body = readFileSync(file, 'utf8');
    if (createHash('sha256').update(body).digest('hex') !== entry.sha256) return { ok: false, reason: `checksum mismatch: ${table}` };
    const rows = body.split('\n').filter(Boolean).length;
    if (rows !== entry.rows) return { ok: false, reason: `row count mismatch: ${table}` };
  }
  return { ok: true, signed: !!m.signature };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: BACKUP_HMAC_KEY=... node scripts/verify-backup-manifest.mjs <backup folder>'); process.exit(2); }
  const keys = [process.env.BACKUP_HMAC_KEY, process.env.BACKUP_HMAC_KEY_PREVIOUS].filter(Boolean);
  const r = verifyFolder(dir, keys);
  console.log(r.ok ? `VERIFIED ${dir}${r.signed ? ' (signature checked)' : ' (unsigned backup: integrity only)'}` : `NOT VERIFIED ${dir}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
