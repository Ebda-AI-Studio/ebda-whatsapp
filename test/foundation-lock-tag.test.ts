import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The lock names a tag AND a commit; this proves they agree. Offline (CI has no foundation checkout) the proof is internal: the vendored package.json that `sync` wrote
// carries the version of the tag and the commit it was cut from, and the lock must match both. With a local foundation checkout (FOUNDATION_REPO, or the usual sibling
// path) the tag is also resolved by git and compared with the lock's commit. The managed parity test (test/foundation-parity.test.ts) is written by `sync` and pinned by
// the lock's sha, so this check lives in its own file.
const lock = JSON.parse(readFileSync(new URL('../foundation.lock.json', import.meta.url), 'utf8')) as { tag: string; commit: string };
const pkg = JSON.parse(readFileSync(new URL('../foundation/package.json', import.meta.url), 'utf8')) as { version: string; foundationCommit: string };

it('the lock tag is the vendored package version and the lock commit is the commit sync recorded', () => {
  expect(lock.tag).toBe(`v${pkg.version}`);
  expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(pkg.foundationCommit).toBe(lock.commit);
});

const candidates = [process.env.FOUNDATION_REPO, `${process.env.HOME}/Desktop/projects/Ebda-AI-Studio/internal-projects/ebda-foundation`].filter((p): p is string => !!p && existsSync(`${p}/.git`));
it.runIf(candidates.length > 0)('with a local foundation checkout: the lock tag resolves to the lock commit', () => {
  let resolved = '';
  try {
    resolved = execFileSync('git', ['-C', candidates[0]!, 'rev-parse', `${lock.tag}^{commit}`], { encoding: 'utf8' }).trim();
  } catch {
    execFileSync('git', ['-C', candidates[0]!, 'fetch', '-q', '--tags'], { timeout: 60_000 });
    resolved = execFileSync('git', ['-C', candidates[0]!, 'rev-parse', `${lock.tag}^{commit}`], { encoding: 'utf8' }).trim();
  }
  expect(resolved).toBe(lock.commit);
});
