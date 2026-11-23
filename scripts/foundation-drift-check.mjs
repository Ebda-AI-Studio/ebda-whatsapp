#!/usr/bin/env node
// CI guard: fails when the vendored foundation (foundation.lock.json) has been more than one release behind the newest
// ebda-foundation tag for more than 7 days. Logic + bounded GitHub reads: scripts/foundation-drift-lib.mjs (tested).
// A GitHub read problem (outage, hang, rate limit) is a ::warning and exit 0, within ~30 s.
import { readFileSync } from 'node:fs';
import { checkDrift } from './foundation-drift-lib.mjs';

const repo = process.env.FOUNDATION_REPO || 'Ebda-AI-Studio/ebda-foundation';
const lock = JSON.parse(readFileSync('foundation.lock.json', 'utf8'));
const r = await checkDrift({ lockTag: lock.tag, repo, token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '' });
if (r.status === 'fail') {
  console.error(`::error title=Foundation drift::${r.message}`);
  process.exit(1);
}
console.log(`foundation drift: ${r.status}: ${r.message}`);
if (r.status === 'unknown' || r.status === 'skipped') console.log(`::warning title=Foundation drift::${r.message}`);
// dangling sockets of an aborted fetch must not keep the step alive
process.exit(0);
