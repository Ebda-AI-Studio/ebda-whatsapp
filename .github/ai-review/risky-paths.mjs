#!/usr/bin/env node
// Decides which changed paths need the independent AI review. FAIL CLOSED: a path is exempt only when it is provably harmless:
//   - markdown (outside .github/), and image/text assets under docs/
//   - a test file that is NEWLY ADDED. A MODIFIED or DELETED existing test is risky: several safety guards ARE test files
//     (across-stores-isolation, no-rls-bypass-in-runtime, no-raw-pii-in-logs, the ai-writers guard, ...), and weakening one is a
//     tests-only diff that removes a production safeguard. A new test can only add coverage.
// Everything else needs review. A word list of "risky" names (the first version) was open by construction.
// Input: `git diff --name-status --no-renames base...head` lines (`A\tpath`, `M\tpath`, `D\tpath`). A line with no status has an unknown status,
// which counts as modified (so an existing test is never exempt by omission).
// Prints the paths that need review. Empty output = an all-safe diff.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MARKDOWN = /\.(?:md|mdx)$/i;
const DOC_ASSET = /^docs\/.+\.(?:md|mdx|txt|png|jpe?g|gif|svg|webp)$/i;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|e2e|tests?)\//;

export function parse(line) {
  const m = /^([A-Z])\d*\t(.+)$/.exec(line.replace(/\r$/, ''));
  return m ? { status: m[1], path: m[2].trim() } : { status: '?', path: line.trim() };
}

/** true only for docs / markdown / newly added tests: nothing that runs in production or CI, and no existing safeguard weakened */
export function isSafe(path, status = '?') {
  const p = path.trim().replace(/^\.\//, '');
  // .github/ holds the gate, its prompt (markdown!) and the workflows: never exempt, whatever the extension
  if (!p || p.includes('..') || p.startsWith('.github/')) return false;
  if (MARKDOWN.test(p) || DOC_ASSET.test(p)) return true;
  return status === 'A' && (TEST_FILE.test(p) || TEST_DIR.test(p));
}

export const isRisky = (path, status = '?') => !isSafe(path, status);
/** @param {string[]} lines `STATUS\tpath` or bare paths */
export const riskyPaths = (lines) => lines.map(parse).filter((x) => x.path && !isSafe(x.path, x.status)).map((x) => x.path);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = riskyPaths(readFileSync(0, 'utf8').split('\n'));
  if (out.length) process.stdout.write(out.join('\n') + '\n');
}
