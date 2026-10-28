#!/usr/bin/env node
// Verifies ONE workspace backup folder offline: signature, every table file (sha256, row count) and that the manifest belongs to this folder's workspace and date.
// Usage: BACKUP_HMAC_KEY=... [BACKUP_HMAC_KEY_PREVIOUS=...] [BACKUP_KEY_SINCE=YYYY-MM-DD] node scripts/verify-backup-manifest-cli.mjs <.../workspaceId/date>
// BACKUP_HMAC_KEY is required. An unsigned manifest is NOT VERIFIED unless the folder's date is before BACKUP_KEY_SINCE: then `LEGACY-UNSIGNED ...` (exit 0, reported, never copied).
// Prints `VERIFIED <workspace> <date> <n> files (...)` and exits 0 ONLY when everything checked out; anything else prints `NOT VERIFIED ...` and exits 1 (2 = usage).
// Callers must require the VERIFIED line AND the exit code. This file has no "am I the entry point" check: it always runs.
import { verifyFolder } from './verify-backup-manifest.mjs';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: BACKUP_HMAC_KEY=... node scripts/verify-backup-manifest-cli.mjs <backup folder>');
  process.exit(2);
}
const keys = [process.env.BACKUP_HMAC_KEY, process.env.BACKUP_HMAC_KEY_PREVIOUS].filter(Boolean);
const keySince = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BACKUP_KEY_SINCE ?? '') ? process.env.BACKUP_KEY_SINCE : undefined;
const r = verifyFolder(dir, keys, { keySince });
if (r.ok && r.legacy) {
  console.log(`LEGACY-UNSIGNED ${r.workspaceId} ${r.date} ${r.files} files (before BACKUP_KEY_SINCE ${keySince}: integrity only, NOT verified as ours)`);
  process.exit(0);
}
if (r.ok) {
  console.log(`VERIFIED ${r.workspaceId} ${r.date} ${r.files} files (signature checked)`);
  process.exit(0);
}
console.log(`NOT VERIFIED ${dir}: ${r.reason}`);
process.exit(1);
