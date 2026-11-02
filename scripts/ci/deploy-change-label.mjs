#!/usr/bin/env node
/**
 * deploy-change-label.mjs - a PR that changes how production is deployed needs the `deploy-change` label (Ruling
 * DEPLOY-PARITY-1 / WA-DEPLOY-3: Whisky-11 is a Free-plan private org, so there is no environment protection and no required-reviewer rules; this
 * check is the human checkpoint). Usage: node scripts/ci/deploy-change-label.mjs --base <sha> --labels '<json array>'
 * Exit 0 ok / not applicable, 1 = deploy files changed and the label is missing.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'deploy-change';
/**
 * Ruling GATE-INVERT-1 (deny by default, the same lesson as the auth rule NZ-D10): a changed file needs the label UNLESS it is on this short allowlist of
 * paths that cannot change how the Worker is built, installed or deployed. Everything else (package.json, any lockfile, scripts/**, wrangler.jsonc, every
 * build or tool config at any depth, .github/**, migrations/**, vendor/**, foundation/**, web/** outside web/src) needs the label, so a new kind of
 * config file is covered the day it appears. Application code (src/**, web/src/**) is allowlisted because CI tests review it; docs, root markdown and
 * tests (except this check's own test) cannot run in a build; the brand image and font folders are copied, not executed.
 */
const NO_LABEL = [
  /^src\//,
  /^web\/src\//,
  /^docs\//,
  /^[^/]+\.md$/,
  /^test\/(?!deploy-change-label\.test\.ts$)/,
  /^web\/brands\/[^/]+\/public\/.+\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?)$/,
];
export const requiresLabel = file => !NO_LABEL.some(re => re.test(file));

export function deployFilesChanged(files) {
  return files.filter(requiresLabel);
}

export function check(files, labels) {
  const changed = deployFilesChanged(files);
  if (changed.length === 0) return { ok: true, changed };
  return { ok: labels.includes(LABEL), changed };
}

/**
 * The PR's OWN changed files. On pull_request CI, HEAD is a merge commit of the PR head into the CURRENT base, so diffing the
 * event's (possibly stale) base sha pulls main's later commits into the list. For a merge commit diff its parents
 * (HEAD^1...HEAD^2 = merge-base..PR head); otherwise (push/local) fall back to base...HEAD.
 */
// A git hook exports GIT_DIR, which would point these calls at the wrong repo.
const cleanEnv = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

export function changedFiles(cwd, base) {
  const git = args =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() })
      .split('\n')
      .filter(Boolean);
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD'])[0]?.split(' ').slice(1) ?? [];
  const range = parents.length === 2 ? 'HEAD^1...HEAD^2' : `${base}...HEAD`;
  return git(['diff', '--name-only', range]);
}

function main(argv) {
  const val = k => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
  const base = val('base');
  const labels = JSON.parse(val('labels') || '[]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = changedFiles(root, base);
  const r = check(files, labels);
  if (!r.ok) {
    console.error(
      `::error::this PR changes production deploy files (${r.changed.join(', ')}) and has no "${LABEL}" label. Add the label after a human has read the diff.`
    );
    return 1;
  }
  console.log(
    r.changed.length
      ? `deploy files changed and labelled "${LABEL}": ${r.changed.join(', ')}`
      : 'no deploy files changed'
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
