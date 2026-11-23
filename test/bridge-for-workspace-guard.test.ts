import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// CHAT-SA-2 defect class: `bridgeFor(env)` is per DEPLOY, so a call that acts for a workspace must go through `bridgeForWorkspace(env, id)`, which is null for a standalone (`sw_`)
// workspace. A new direct `bridgeFor(` call would silently reach the Store for a workspace that has none. Allowed: its definition (store-link.ts) and the Store-event consumer
// (store-events.ts, UUID-only after the kind check). Escape: `// bridge-for-ok: <why>` on the same or previous line.
const ROOT = resolve(__dirname, '..');
const ALLOWED = new Set(['src/core/store-link.ts', 'src/core/store-events.ts']);
const files = (dir: string): string[] =>
  readdirSync(resolve(ROOT, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    if (statSync(resolve(ROOT, rel)).isDirectory()) return files(rel);
    return /\.(ts|tsx)$/.test(rel) ? [rel] : [];
  });
const direct = (f: string, src: string): string[] => {
  const lines = src.split('\n');
  return lines.flatMap((l, i) => (/\bbridgeFor\(/.test(l.replace(/\/\/.*$/, '')) && !/bridge-for-ok:/.test(l) && !/bridge-for-ok:/.test(lines[i - 1] ?? '') ? [`${f}:${i + 1}`] : []));
};

it('flags a direct bridgeFor( call and passes bridgeForWorkspace( (fixtures)', () => {
  expect(direct('x.ts', 'const b = bridgeFor(env);')).toEqual(['x.ts:1']);
  expect(direct('x.ts', 'const b = bridgeForWorkspace(env, id);')).toEqual([]);
  expect(direct('x.ts', '// bridge-for-ok: no workspace\nconst b = bridgeFor(env);')).toEqual([]);
});
it('no src file calls bridgeFor( directly outside the allowed two', () => {
  const bad = files('src').filter((f) => !ALLOWED.has(f)).flatMap((f) => direct(f, readFileSync(resolve(ROOT, f), 'utf8')));
  expect(bad, 'use bridgeForWorkspace(env, workspaceId): null for standalone workspaces').toEqual([]);
});
