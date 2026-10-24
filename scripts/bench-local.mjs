#!/usr/bin/env node
// Runs test/perf.test.ts inside workerd (the only in-process runtime that hosts Durable Objects here: no servers, no
// Docker, no network) and prints the BENCH line it logs as a table. Numbers are "measured (local)", never live figures.
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'test/perf.test.ts', '--reporter=verbose'], { encoding: 'utf8', env: { ...process.env, BENCH: '1' } });
const line = (r.stdout + r.stderr).split('\n').find((l) => l.startsWith('BENCH '));
if (!line) {
  console.error(r.stdout, r.stderr);
  console.error('no BENCH line: the perf test failed');
  process.exit(1);
}
const b = JSON.parse(line.slice(6));
console.log(`measured (local) with ${b.conversations} conversations seeded; milliseconds`);
console.table(Object.fromEntries(Object.entries(b).filter(([, v]) => typeof v === 'object')));
process.exit(r.status ?? 0);
