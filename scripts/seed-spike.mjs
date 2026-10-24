#!/usr/bin/env node
// Registers the spike workspace and the Meta test number in the remote D1 (ebda-wa-platform).
// Usage: node scripts/seed-spike.mjs --phone-number-id <id> --waba <id> [--display <+1555…>]
import { execFileSync } from 'node:child_process';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const pnid = arg('phone-number-id');
const waba = arg('waba');
const display = arg('display') ?? null;
const digits = /^\d{5,20}$/;
if (!pnid || !waba || !digits.test(pnid) || !digits.test(waba)) {
  console.error('usage: --phone-number-id <digits> --waba <digits> [--display <text>]');
  process.exit(2);
}
const esc = (v) => (v === null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`);
const sql = [
  `INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('ws-spike', 'Spike', ${Date.now()});`,
  `INSERT INTO phone_numbers (phone_number_id, waba_id, workspace_id, display_phone, status) VALUES (${esc(pnid)}, ${esc(waba)}, 'ws-spike', ${esc(display)}, 'active')`,
  `  ON CONFLICT(phone_number_id) DO UPDATE SET waba_id = excluded.waba_id, workspace_id = 'ws-spike', status = 'active';`,
].join('\n');
execFileSync('npx', ['wrangler', 'd1', 'execute', 'ebda-wa-platform', '--remote', '--command', sql], { stdio: 'inherit' });
