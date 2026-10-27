#!/usr/bin/env node
// Verifies ONE workspace backup folder offline: signature, every table file (sha256, row count) and that the manifest belongs to this folder's workspace and date.
// Usage: BACKUP_HMAC_KEY=... [BACKUP_HMAC_KEY_PREVIOUS=...] node scripts/verify-backup-manifest-cli.mjs <.../workspaceId/date>
// Prints `VERIFIED <workspace> <date> <n> files (...)` and exits 0 ONLY when everything checked out; anything else prints `NOT VERIFIED ...` and exits 1 (2 = usage).
// Callers must require the VERIFIED line AND the exit code. This file has no "am I the entry point" check: it always runs.
import { verifyFolder } from './verify-backup-manifest.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: BACKUP_HMAC_KEY=... node scripts/verify-backup-manifest-cli.mjs <backup folder>');
  process.exit(2);
}
const keys = [process.env.BACKUP_HMAC_KEY, process.env.BACKUP_HMAC_KEY_PREVIOUS].filter(Boolean);
const r = verifyFolder(dir, keys);
if (r.ok) {
  console.log(`VERIFIED ${r.workspaceId} ${r.date} ${r.files} files (${r.signed ? 'signature checked' : 'unsigned backup: integrity only'})`);
  process.exit(0);
}
console.log(`NOT VERIFIED ${dir}: ${r.reason}`);
process.exit(1);
