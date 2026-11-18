/**
 * Did `npm audit` actually tell us anything?
 *
 * The gate read `report.vulnerabilities ?? {}` and treated an empty result as
 * clean. But npm emits JSON on failure too — an `{ error: … }` object with no
 * `vulnerabilities` key at all — so a registry timeout produced zero findings,
 * an empty `blocking` list, and `audit-gate: clean` with exit 0. Observed
 * locally on 2026-09-04: `npm error audit endpoint returned an error`, gate
 * reported clean.
 *
 * `Security Audit` is one of the eleven REQUIRED checks. A network blip could
 * therefore pass it without consulting the advisory database once — the same
 * absence-read-as-all-clear that this repo has now been bitten by in the deploy
 * gate, the scoped audit and the followup dedup.
 *
 * A report that does not carry a vulnerabilities map is not a clean report; it
 * is not a report. The distinction has to be drawn before any counting starts.
 */

export const AUDIT = Object.freeze({
  CLEAN: 'clean',
  BLOCKING: 'blocking',
  UNUSABLE: 'unusable', // npm answered, but not with an audit result
});

/**
 * @param report parsed `npm audit --json` output
 * @param allow  Map of advisory id → documented waiver reason
 */
export function classifyAuditReport(report, allow = new Map()) {
  if (!report || typeof report !== 'object') {
    return {
      verdict: AUDIT.UNUSABLE,
      reason: 'audit output was not an object',
      blocking: [],
      waived: [],
    };
  }

  // npm's own error envelope. Present exactly when it could not audit.
  if (report.error) {
    const summary = report.error.summary || report.error.code || 'unknown error';
    return {
      verdict: AUDIT.UNUSABLE,
      reason: `npm audit failed: ${summary}`,
      blocking: [],
      waived: [],
    };
  }

  // The success shape always carries this map, empty when nothing is wrong.
  // Absent means npm was answering a different question.
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    return {
      verdict: AUDIT.UNUSABLE,
      reason:
        'audit output carried no vulnerabilities map — this is not a clean report, it is not a report',
      blocking: [],
      waived: [],
    };
  }

  const blocking = [];
  const waived = [];
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    for (const via of v?.via ?? []) {
      if (typeof via !== 'object') continue;
      const id = (via.url ?? '').split('/').pop();
      (allow.has(id) ? waived : blocking).push(
        `${name} ${via.severity} ${id} — ${via.title ?? ''}`
      );
    }
  }

  return {
    verdict: blocking.length ? AUDIT.BLOCKING : AUDIT.CLEAN,
    reason: null,
    blocking,
    waived,
  };
}

/** Only a genuinely clean report passes. Unusable is a failure, not a pass. */
export function auditExitCode(verdict) {
  return verdict === AUDIT.CLEAN ? 0 : 1;
}
