import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// T25: one incident runbook per P0/P1 alert, at docs/runbooks/alerts/<name>.md (the alert message links to that exact file).
const obs = readFileSync(new URL('../src/core/observability.ts', import.meta.url), 'utf8');
const setOf = (name: string): string[] => {
  const body = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`).exec(obs)?.[1] ?? '';
  return [...new Set([...body.replace(/\/\/[^\n]*/g, '').matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!))];
};
const P0 = setOf('P0_ALERTS');
const P1 = setOf('P1_ALERTS');
const HEADINGS = ['## What it means', '## Impact', '## Check first', '## Fix', '## Verify it is resolved', '## Related'];
const file = (n: string) => new URL(`../docs/runbooks/alerts/${n}.md`, import.meta.url);

it('the guard reads the real sets (not vacuous)', () => {
  expect(P0.length).toBeGreaterThanOrEqual(10);
  expect(P1.length).toBeGreaterThanOrEqual(80);
});

it('every P0 and P1 alert name has a runbook with the standard sections and its own severity', () => {
  const missing = [...P0, ...P1].filter((n) => !existsSync(file(n)));
  expect(missing, 'alerts with no docs/runbooks/alerts/<name>.md').toEqual([]);
  for (const n of [...P0, ...P1]) {
    const text = readFileSync(file(n), 'utf8');
    expect(text.startsWith(`# ${n} (${P0.includes(n) ? 'P0' : 'P1'})`), `${n}: title line with its severity`).toBe(true);
    for (const h of HEADINGS) expect(text, `${n}: ${h}`).toContain(h);
    expect(text.split('\n').length, `${n}: a runbook is read at 3 a.m., keep it short`).toBeLessThanOrEqual(45);
  }
});

it('no runbook is an orphan: every file names an alert that exists', () => {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const known = new Set([...P0, ...P1, ...setOf("INFO_ALERTS"), "store_plan_incomplete"]);
  const files = readdirSync(new URL('../docs/runbooks/alerts/', import.meta.url)).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  expect(files.filter((f) => !known.has(f))).toEqual([]);
});

it('no runbook contains a phone-number-like run of digits or a token-like string', () => {
  for (const n of [...P0, ...P1]) {
    const text = readFileSync(file(n), 'utf8');
    expect(text, n).not.toMatch(/\d{9,}/);
    expect(text, n).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
  }
});

it('every route a runbook tells a human to call exists in the code', () => {
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const src = readdirSync(new URL('../src/routes/', import.meta.url)).map((f) => readFileSync(new URL(`../src/routes/${f}`, import.meta.url), 'utf8')).join('\n') + readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const have = [...src.matchAll(/\.(get|post|put|patch|delete)\(\s*['`]([^'`]+)['`]/g)].map((m) => [m[1]!.toUpperCase(), m[2]!.replace(/:[A-Za-z]+/g, ':p')] as const);
  expect(have.length).toBeGreaterThan(50);
  const missing: string[] = [];
  for (const n of [...P0, ...P1]) {
    for (const m of readFileSync(file(n), 'utf8').matchAll(/\b(GET|POST|PUT|PATCH|DELETE) (\/api\/v1\/[A-Za-z0-9_/:{}-]+)/g)) {
      const p = m[2]!.replace('/api/v1', '').replace('/operator', '').replace(/:[A-Za-z]+/g, ':p').replace(/\{[^}]+\}/g, ':p');
      if (!have.some(([mm, pp]) => mm === m[1] && (pp === p || pp.endsWith(p)))) missing.push(`${n}: ${m[0]}`);
    }
  }
  expect(missing).toEqual([]);
});
