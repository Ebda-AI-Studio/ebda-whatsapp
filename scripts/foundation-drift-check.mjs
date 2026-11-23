#!/usr/bin/env node
// CI guard: fails when the vendored foundation (foundation.lock.json) has been more than one release behind the newest
// ebda-foundation tag for more than 7 days. Logic: scripts/foundation-drift-lib.mjs (tested). A GitHub read failure is a
// ::warning and exit 0: an outage of api.github.com must not block every merge (the check runs on every PR, so a real drift is
// seen within a PR or two).
import { readFileSync } from 'node:fs';
import { evaluateDrift } from './foundation-drift-lib.mjs';

const REPO = process.env.FOUNDATION_REPO || 'Ebda-AI-Studio/ebda-foundation';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
const get = async path => {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
};

try {
  const lock = JSON.parse(readFileSync('foundation.lock.json', 'utf8'));
  const tags = await get('tags?per_page=30');
  const dated = [];
  for (const t of tags) {
    const c = await get(`commits/${t.commit.sha}`);
    dated.push({ name: t.name, date: c.commit.committer.date });
  }
  const r = evaluateDrift({ lockTag: lock.tag, tags: dated });
  if (r.status === 'fail') {
    console.error(`::error title=Foundation drift::${r.message}`);
    process.exit(1);
  }
  console.log(`foundation drift: ${r.status}: ${r.message}`);
  if (r.status === 'unknown') console.log(`::warning title=Foundation drift::${r.message}`);
} catch (err) {
  console.log(`::warning title=Foundation drift::could not read ${REPO} tags (${err instanceof Error ? err.message : err}); check skipped`);
}
