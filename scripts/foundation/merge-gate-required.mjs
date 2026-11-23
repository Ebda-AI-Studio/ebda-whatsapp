#!/usr/bin/env node
// Prints (JSON array) the check names ops/merge-gate.sh requires to be an explicit SUCCESS, DERIVED from
// .github/workflows/*.yml so the list cannot drift from the workflows:
//   a job is required when its workflow runs on EVERY pull_request (no `paths` / `paths-ignore` filter on that trigger)
//   AND the job always runs on a PR, i.e. it has no job-level `if`, or its `if` is exactly
//   `github.event_name == 'pull_request'` or the fork guard, and everything it `needs` is itself such a job.
// A path-filtered workflow creates NO check run for a PR outside its filter, so it can never be required (requiring it
// waits the full --max-wait-min for a check that will never exist). When it does run it must still finish and not fail.
// Conditional jobs (lint, unit, worker dry-runs ... gated on the affected-workspace outputs) may legitimately be
// SKIPPED and are checked for "completed and not failing" instead. Jobs whose name is a matrix expression are skipped.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// the fork guard (workflow-lint demands it on every PR job) skips only fork PRs, so it still counts as always-on
const ALWAYS_IF = /^(github\.event_name == 'pull_request'|github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository)$/;
// An aggregator that runs even when the jobs it needs were (legitimately) skipped (`always() [&& !cancelled()] &&
// github.event_name == 'pull_request'`, e.g. ebda-store's `Unit Tests (affected)`) always reports on a PR, so it is
// required regardless of its needs. Without this the gate never required those checks (fail-open). Same regex as
// ebda-store scripts/ci/merge-gate-required.mjs.
const ALWAYS_RUN_IF = /^always\(\) (&& !cancelled\(\) )?&& github\.event_name == 'pull_request'$/;

export function parseWorkflow(text) {
  const lines = text.split('\n');
  const onPr = (() => {
    const i = lines.findIndex(l => /^on:\s*$/.test(l));
    if (i < 0) return /^on:.*pull_request/m.test(text);
    for (let j = i + 1; j < lines.length && /^(\s|$)/.test(lines[j]); j++) if (/^\s+pull_request\s*:/.test(lines[j])) return true;
    return false;
  })();
  // true when the pull_request trigger itself carries paths / paths-ignore (block or inline); a filter on push only is not
  const prPathFiltered = (() => {
    if (/^on:.*pull_request\s*:\s*\{[^}]*\bpaths(-ignore)?\s*:/m.test(text)) return true;
    const i = lines.findIndex(l => /^\s+pull_request\s*:/.test(l));
    if (i < 0) return false;
    if (/\bpaths(-ignore)?\s*:/.test(lines[i])) return true;
    const indent = lines[i].match(/^\s*/)[0].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '' || /^\s*#/.test(lines[j])) continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      if (/^\s+paths(-ignore)?\s*:/.test(lines[j])) return true;
    }
    return false;
  })();
  const jobs = {};
  let inJobs = false;
  let cur = null;
  for (const raw of lines) {
    if (/^jobs:\s*$/.test(raw)) { inJobs = true; continue; }
    if (inJobs && /^\S/.test(raw) && raw.trim() !== '') { inJobs = false; cur = null; }
    if (!inJobs) continue;
    let m = raw.match(/^  ([\w-]+):\s*$/);
    if (m) { cur = jobs[m[1]] = { id: m[1], name: null, if: null, needs: [] }; continue; }
    if (!cur) continue;
    if ((m = raw.match(/^    name:\s*(.+?)\s*$/))) cur.name = m[1].replace(/^['"]|['"]$/g, '');
    else if ((m = raw.match(/^    if:\s*(.+?)\s*$/))) cur.if = m[1];
    else if ((m = raw.match(/^    needs:\s*(.+?)\s*$/))) cur.needs = m[1].replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return { onPr, prPathFiltered, jobs };
}

export function requiredChecks(dir) {
  const out = new Set();
  for (const f of readdirSync(dir).filter(f => /\.ya?ml$/.test(f))) {
    const { onPr, prPathFiltered, jobs } = parseWorkflow(readFileSync(join(dir, f), 'utf8'));
    if (!onPr || prPathFiltered) continue;
    const always = id => {
      const j = jobs[id];
      if (!j) return false;
      if (j.if !== null && ALWAYS_RUN_IF.test(j.if)) return true;
      if (j.if !== null && !ALWAYS_IF.test(j.if)) return false;
      return j.needs.every(always);
    };
    for (const j of Object.values(jobs)) if (always(j.id)) {
      const name = j.name ?? j.id;
      if (!name.includes('${{')) out.add(name);
    }
  }
  return [...out].sort();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  console.log(JSON.stringify(requiredChecks(process.argv[2] ?? '.github/workflows')));
}
