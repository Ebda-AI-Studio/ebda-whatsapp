/** Ruling AUDIT-SPLIT-1: the audit allow-list (.github/audit-allow.json). An expired entry fails the gate; an invalid one too; a live one waives only its advisory. */
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error plain .mjs without types
import { evaluateAllow, loadAllow, MAX_DAYS } from '../.github/scripts/audit-allow.mjs';
// @ts-expect-error plain .mjs without types
import { classifyAuditReport, AUDIT } from '../.github/scripts/audit-report-verdict.mjs';

const NOW = new Date('2026-11-17T12:00:00Z');
const entry = (o: Record<string, unknown> = {}) => ({
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  reason: 'no patched version exists; build-time tooling only',
  expires: '2026-12-17',
  ...o,
});
const advisory = (id: string) => ({
  via: [{ url: `https://github.com/advisories/${id}`, severity: 'high', title: 't' }],
});

describe('evaluateAllow', () => {
  it('a live entry waives its advisory', () => {
    const r = evaluateAllow([entry()], NOW);
    expect([...r.allow.keys()]).toEqual(['GHSA-fc5q-39xc-vjpf']);
    expect(r.expired).toEqual([]);
    expect(r.invalid).toEqual([]);
  });
  it('an EXPIRED entry does not waive and is reported (so the step fails)', () => {
    const r = evaluateAllow([entry({ expires: '2026-11-16' })], NOW);
    expect(r.allow.size).toBe(0);
    expect(r.expired).toHaveLength(1);
    expect(r.expired[0]).toContain('GHSA-fc5q-39xc-vjpf');
    expect(r.expired[0]).toContain('expired 2026-11-16');
  });
  it('the expiry day itself still waives (expired means strictly before today)', () => {
    expect(evaluateAllow([entry({ expires: '2026-11-17' })], NOW).allow.size).toBe(1);
  });
  it('rejects a bad id, a missing reason, a bad date and an expiry beyond the cap', () => {
    for (const bad of [
      entry({ id: 'CVE-2026-1' }),
      entry({ reason: 'ok' }),
      entry({ package: '' }),
      entry({ expires: '17/12/2026' }),
      entry({ expires: '2099-01-01' }),
    ])
      expect(evaluateAllow([bad], NOW).invalid, JSON.stringify(bad)).toHaveLength(1);
    expect(evaluateAllow({} as never, NOW).invalid).toHaveLength(1);
    expect(MAX_DAYS).toBe(90);
  });
  it('an expired entry makes the advisory BLOCK again in the classifier', () => {
    const live = evaluateAllow([entry()], NOW).allow;
    const dead = evaluateAllow([entry({ expires: '2026-11-01' })], NOW).allow;
    const report = { vulnerabilities: { picomatch: advisory('GHSA-fc5q-39xc-vjpf') } };
    expect(classifyAuditReport(report, live).verdict).toBe(AUDIT.CLEAN);
    expect(classifyAuditReport(report, dead).verdict).toBe(AUDIT.BLOCKING);
  });
  it('a different advisory is not waived by the picomatch entry', () => {
    const report = { vulnerabilities: { braces: advisory('GHSA-vfj7-8cjw-p6xm') } };
    expect(classifyAuditReport(report, evaluateAllow([entry()], NOW).allow).verdict).toBe(
      AUDIT.BLOCKING
    );
  });
});

describe('loadAllow', () => {
  it('reads a file, and an unreadable or malformed file is invalid (fail closed)', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'allow-'));
    writeFileSync(path.join(d, 'ok.json'), JSON.stringify([entry()]));
    writeFileSync(path.join(d, 'bad.json'), '{ not json');
    expect(loadAllow(path.join(d, 'ok.json'), NOW).allow.size).toBe(1);
    expect(loadAllow(path.join(d, 'bad.json'), NOW).invalid).toHaveLength(1);
    expect(loadAllow(path.join(d, 'missing.json'), NOW).invalid).toHaveLength(1);
  });
});

describe('the repo files', () => {
  const root = path.resolve(__dirname, '..');
  it('audit-allow.json is valid today and carries the picomatch entry with the 2026-12-17 expiry', () => {
    const entries = JSON.parse(readFileSync(path.join(root, '.github/audit-allow.json'), 'utf8'));
    const e = entries.find((x: { id: string }) => x.id === 'GHSA-fc5q-39xc-vjpf');
    expect(e.package).toBe('picomatch');
    expect(e.expires).toBe('2026-12-17');
    expect(e.reason).toContain('Drop when picomatch ships a fix');
    // the real gate decision on the real file: from the day this landed, nothing invalid; it EXPIRES for real after 2026-12-17
    expect(evaluateAllow(entries, NOW)).toMatchObject({ expired: [], invalid: [] });
    expect(evaluateAllow(entries, new Date('2026-12-18T00:00:00Z')).expired).toHaveLength(1);
  });
  it('the gate reads the file and fails on expired/invalid; production is blocking, --all is a continue-on-error report', () => {
    const gate = readFileSync(path.join(root, '.github/scripts/audit-gate.mjs'), 'utf8');
    expect(gate).toContain('loadAllow(');
    expect(gate).toMatch(/invalid\.length \|\| expired\.length[\s\S]*process\.exit\(1\)/);
    expect(gate).toMatch(/ALL \? \[\] : \['--omit=dev'\]/);
    const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toMatch(/\n\s+run: node \.github\/scripts\/audit-gate\.mjs\n/);
    expect(ci).not.toMatch(/run: npm audit/);
    expect(ci).toMatch(
      /continue-on-error: true\n\s+run: node \.github\/scripts\/audit-gate\.mjs --all/
    );
  });
});
