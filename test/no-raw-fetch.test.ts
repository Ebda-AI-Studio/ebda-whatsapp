import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// Ruling PERF-TIMEOUTS-1: every third-party call goes through fetchWithTimeout (src/core/net/fetch-with-timeout.ts), so none can hang on a
// stalled upstream. A bare global `fetch` identifier (a call, or a `?? fetch` / `= fetch` value reference) bypasses it. Decided on the AST, not on text:
// `x.fetch(...)` (service bindings, assets, DO stubs), `typeof fetch` in a type, and the NAME of a method declaration are not uses of the global.
// The only exemption is the Durable Object's own `fetch` method DECLARATION NAME in src/core/workspace-do.ts; its body is scanned like any other code.
const ROOT = join(import.meta.dirname, '..');
const HELPER = 'src/core/net/fetch-with-timeout.ts';
const DO_FILE = 'src/core/workspace-do.ts';

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}

/** `file:line` of every bare global `fetch` use in `source` (`file` is the repo-relative name it is judged under). */
export function rawFetchUses(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === 'fetch') {
      const p = n.parent;
      const isMember = ts.isPropertyAccessExpression(p) && p.name === n;
      const isTypeUse = ts.isTypeQueryNode(p);
      const isDeclName = (ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isPropertyAssignment(p)) && p.name === n;
      const isDoMethodName = file === DO_FILE && ts.isMethodDeclaration(p) && p.name === n;
      if (!isMember && !isTypeUse && !isDeclName && !isDoMethodName) {
        hits.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

it('no raw global fetch under src/ outside the timeout helper', () => {
  const hits = files(join(ROOT, 'src')).flatMap((f) => {
    const rel = relative(ROOT, f);
    return rel === HELPER ? [] : rawFetchUses(readFileSync(f, 'utf8'), rel);
  });
  expect(hits).toEqual([]);
});

it('the matcher catches the bare forms and spares the member forms (negative control)', () => {
  for (const bad of ['await fetch(url)', 'const res = fetch(url, init)', 'const f = cfg.fetcher ?? fetch;', 'const g = (u, i) => fetch(u, i)']) {
    expect(rawFetchUses(bad, 'src/x.ts'), bad).toHaveLength(1);
  }
  for (const ok of ['c.env.ASSETS.fetch(req)', 'ws.fetch(req)', 'type T = { fetcher?: typeof fetch }', 'fetchWithTimeout(url, init, o)', '// passed-through fetch() responses']) {
    expect(rawFetchUses(ok, 'src/x.ts'), ok).toEqual([]);
  }
});

it('only the DO fetch method NAME is exempt: a raw fetch on the same line or in its body still fails (bypass fixtures)', () => {
  const method = 'class D { override async fetch(r: Request) { return r; } }';
  expect(rawFetchUses(method, DO_FILE)).toEqual([]);
  expect(rawFetchUses(method, 'src/other.ts')).toHaveLength(1); // the exemption is that one file's declaration only
  expect(rawFetchUses('class D { override async fetch(r: Request) { return fetch(r); } }', DO_FILE)).toHaveLength(1); // same line, body call
  expect(rawFetchUses('class D {\n  override async fetch(r: Request) {\n    return fetch(r);\n  }\n}', DO_FILE)).toEqual([`${DO_FILE}:3`]);
  expect(rawFetchUses('class D { override async fetch(r: Request) { return r; } }; const g = fetch;', DO_FILE)).toHaveLength(1);
});
