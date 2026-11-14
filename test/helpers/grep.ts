import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist', 'coverage', '.superpowers']);
// Files that must name the banned strings in order to ban them.
// vendor/studio is the Store's shared studio-pages renderer + brand, byte-identical and sha-pinned (test/vendored-artifacts.test.ts): its text is the Store's, not ours to edit.
// foundation/ is vendored byte for byte and pinned by foundation.lock.json (test/foundation-parity.test.ts); its text is the foundation repo's, whose own guards police it (a v0.3.0 comment uses an ordinary English word the banned-string pattern also matches).
const ALLOW = [/^foundation\//, /^vendor\/studio\//, /^test\/guards\.test\.ts$/, /^CLAUDE\.md$/, /^docs\/plans\//];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/** Returns `path:line` for every line under `sub` (repo-relative) that matches `re`. */
export function findMatches(re: RegExp, sub = '.'): string[] {
  const files: string[] = [];
  walk(join(ROOT, sub), files);
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (ALLOW.some((a) => a.test(rel))) continue;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}
