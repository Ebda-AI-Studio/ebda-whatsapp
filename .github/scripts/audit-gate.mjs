#!/usr/bin/env node
/**
 * Audit gate (Ruling AUDIT-SPLIT-1, the same as ebda-store): production dependencies BLOCK, everything else is a non-blocking report.
 *   (default)  `npm audit --omit=dev`: production dependencies, BLOCKING (zero tolerance beyond the allow-list).
 *   --all      every dependency incl. development tooling: run as a continue-on-error step; exits 1 for an advisory that is not allow-listed.
 * Waivers live in `.github/audit-allow.json` (id, package, reason, expiry). An expired or malformed entry fails the gate by itself.
 * A report with no vulnerabilities map is not a clean report (registry blip): retried, then failed closed.
 */
import { execFileSync } from 'node:child_process';
import { loadAllow } from './audit-allow.mjs';
import { classifyAuditReport, auditExitCode, AUDIT } from './audit-report-verdict.mjs';

const ALL = process.argv.includes('--all');
const ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 110_000;

const { allow, expired, invalid } = loadAllow(new URL('../audit-allow.json', import.meta.url).pathname);
if (invalid.length || expired.length) {
  console.error('audit-gate: the allow-list needs attention:');
  for (const m of [...invalid, ...expired]) console.error('  ' + m);
  process.exit(1);
}

function runAudit() {
  try {
    return execFileSync('npm', ['audit', ...(ALL ? [] : ['--omit=dev']), '--json', '--fetch-timeout=45000', '--fetch-retries=1'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: ATTEMPT_TIMEOUT_MS,
    });
  } catch (e) {
    return e.stdout; // npm exits non-zero when vulnerabilities exist; the JSON is still on stdout
  }
}

let report = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const raw = runAudit();
  try {
    const probe = raw ? JSON.parse(raw) : null;
    if (probe && !probe.error && probe.vulnerabilities && typeof probe.vulnerabilities === 'object') {
      report = probe;
      break;
    }
  } catch {
    /* unusable, retried */
  }
  if (attempt < ATTEMPTS) {
    console.error(`audit-gate: attempt ${attempt}/${ATTEMPTS} did not return a usable report, retrying`);
    execFileSync('sleep', [String(Math.min(attempt * 5, 10))]);
  }
}
if (!report) {
  console.error(`audit-gate: no usable audit report after ${ATTEMPTS} bounded attempts (${ATTEMPT_TIMEOUT_MS / 1000}s each): a slow or unreachable registry, not a finding. Refusing to report clean.`);
  process.exit(1);
}

const { verdict, reason, blocking, waived } = classifyAuditReport(report, allow);
if (verdict === AUDIT.UNUSABLE) {
  console.error(`audit-gate: ${reason}`);
  process.exit(auditExitCode(verdict));
}
if (waived.length) {
  console.log('::group::waived (documented, no upstream fix)');
  for (const w of new Set(waived)) console.log('  WAIVED  ' + w);
  console.log('::endgroup::');
}
if (verdict === AUDIT.BLOCKING) {
  console.error(`audit-gate: ${ALL ? 'NOT ALLOW-LISTED advisories (all dependencies, non-blocking report)' : 'BLOCKING production advisories'}:`);
  for (const b of new Set(blocking)) console.error('  ' + b);
  process.exit(auditExitCode(verdict));
}
const used = new Set(waived.map(w => w.split(' ')[2]));
// only the all-dependencies scope can say an entry is dead: the production scope never sees a development-only advisory
if (ALL) for (const id of allow.keys()) if (!used.has(id)) console.log(`audit-gate: allow-list entry ${id} matched nothing: remove it (the advisory is gone).`);
console.log(`audit-gate: clean (${new Set(waived).size} documented waiver(s))`);
