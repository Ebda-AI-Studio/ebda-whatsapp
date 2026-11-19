// Consumes headless `claude -p --output-format json` output, parses the strict
// finding contract, posts inline PR comments, then decides the gate:
//   - no criticals                 -> exit 0 (pass)
//   - criticals + auto-fix enabled -> stage findings + set should_fix, exit 0
//                                     (a later workflow step pushes the fix)
//   - criticals + cannot auto-fix  -> exit 1 (block for human)
// Infra/parse/network errors: FAIL_CLOSED=true (set by the workflow for risky paths) exits 1 so an
// unreviewed money/auth/data change can never be labelled ai-review-passed; unset keeps the old
// fail-open behaviour for advisory use (Ruling AIR-1, ci/ai-review/README.md).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The job's own RUNNER_TEMP, never a fixed /tmp path: two runners share one Mac host and a fixed path let one PR's
// review read another's verdict (Ruling CI-MAC-RUNNER-1).
const SCRATCH = process.env.RUNNER_TEMP || tmpdir();

const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY, // owner/repo
  PR_NUMBER,
  HEAD_SHA,
  CLAUDE_OUTPUT = join(SCRATCH, 'claude-out.json'),
  AI_FIX_ENABLED = 'false', // 'true' only when the AI_FIX_PAT secret is present
  HEAD_IS_AI_FIX = 'false', // 'true' when HEAD is already an [ai-fix] commit
  GITHUB_OUTPUT,
  FAIL_CLOSED = 'false',
  GITHUB_API_URL = 'https://api.github.com',
} = process.env;

const failClosed = FAIL_CLOSED === 'true';
// One exit for every infra problem: closed blocks, open lets the PR through.
function infraExit(msg) {
  console.error(`${msg} (${failClosed ? 'fail-closed: blocking' : 'fail-open: skipping'}).`);
  process.exit(failClosed ? 1 : 0);
}

if (!GITHUB_TOKEN) {
  infraExit('GITHUB_TOKEN not set');
}
const repoParts = (GITHUB_REPOSITORY || '').split('/');
if (repoParts.length !== 2) {
  infraExit('GITHUB_REPOSITORY missing/malformed');
}
const [owner, repo] = repoParts;

// 1. Pull Claude's text result out of the CLI JSON envelope (.result field)
let modelText;
try {
  const envelope = JSON.parse(readFileSync(CLAUDE_OUTPUT, 'utf8'));
  modelText = typeof envelope === 'string' ? envelope : envelope.result;
} catch (e) {
  infraExit(`Could not read Claude CLI output: ${e.message}`);
}
if (!modelText) {
  infraExit('Empty model result');
}

// 2. Parse the finding contract (tolerate code fences / surrounding prose)
function extractJson(s) {
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : s;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return candidate.slice(start, end + 1);
}
let result;
try {
  result = JSON.parse(extractJson(modelText));
} catch (e) {
  console.error('Model output:\n', modelText);
  infraExit('Model did not return valid JSON');
}

if (!result || !Array.isArray(result.findings)) infraExit('Model JSON has no findings array');
const findings = result.findings ?? [];
const KNOWN = ['critical', 'warning', 'info'];
// A severity the contract does not define cannot be trusted as harmless: under fail-closed it counts as critical.
const isCritical = f => f.severity === 'critical' || (failClosed && !KNOWN.includes(f.severity));
const critical = findings.filter(isCritical);

// 3. Post a summary review + inline comments via GitHub REST
async function gh(method, path, body) {
  const r = await fetch(`${GITHUB_API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) console.error(`gh ${method} ${path} -> ${r.status}`, await r.text());
  return r;
}

const SEV = { critical: '[critical]', warning: '[warning]', info: '[info]' };
const comments = findings
  .filter(f => f.file && f.line)
  .map(f => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT',
    body: `${SEV[f.severity] || ''} **${String(f.severity).toUpperCase()} · ${f.category}** (AI review)\n\n${f.comment}`,
  }));
const list = findings
  .map(
    f =>
      `- ${SEV[f.severity] || ''} **${String(f.severity).toUpperCase()}** \`${f.file || '?'}:${f.line || '?'}\` (${f.category}) — ${f.comment}`
  )
  .join('\n');

const willFix = critical.length > 0 && AI_FIX_ENABLED === 'true' && HEAD_IS_AI_FIX !== 'true';

const summary =
  `### AI review\n\n${result.summary || ''}\n\n` +
  `- critical: ${critical.length}\n` +
  `- warning: ${findings.filter(f => f.severity === 'warning').length}\n` +
  `- info: ${findings.filter(f => f.severity === 'info').length}\n\n` +
  (critical.length
    ? willFix
      ? '**Critical findings detected — pushing an automated fix; a fresh review will validate it.**'
      : HEAD_IS_AI_FIX === 'true'
        ? '**Critical findings remain after an automated fix — blocked for human review.**'
        : '**Blocked until the critical findings are resolved or explicitly waived.**'
    : 'No critical findings — warnings/info are advisory only.');

try {
  const rv = await gh('POST', `/repos/${owner}/${repo}/pulls/${PR_NUMBER}/reviews`, {
    commit_id: HEAD_SHA,
    event: 'COMMENT',
    body: summary,
    comments,
  });
  if (!rv.ok) {
    const fallback = await gh('POST', `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`, {
      body: summary + (list ? `\n\n_(inline anchoring failed; findings below)_\n\n${list}` : ''),
    });
    // Same class as audit.mjs's upsertMarkerComment (#1453): gh() only
    // console.error()s a non-ok response, it never throws. If this fallback
    // ALSO fails (rate limit, missing `pull-requests: write`), the review
    // findings — including any critical ones about to block or auto-fix this
    // PR — are silently unreported anywhere a human would see them.
    if (!fallback.ok) {
      console.error(
        `::error::ai-review could not post its findings to the PR (review HTTP ${rv.status}, ` +
          `fallback comment HTTP ${fallback.status}). ${critical.length} critical finding(s) ` +
          `are unreported; only this job's log carries them.`
      );
    }
  }
} catch (e) {
  console.error('GitHub API call failed (findings may be unposted):', e.message);
}

// 4. Gate / hand-off
if (critical.length === 0) {
  console.log('AI review passed (no critical findings).');
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'passed=true\n');
  process.exit(0);
}

if (willFix) {
  try {
    writeFileSync(join(SCRATCH, 'ai-fix-findings.json'), JSON.stringify(critical, null, 2));
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'should_fix=true\n');
    console.log(`${critical.length} critical finding(s) — handing off to the auto-fix step.`);
    process.exit(0);
  } catch (e) {
    console.error('Could not stage auto-fix hand-off:', e.message);
    process.exit(1);
  }
}

if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'verdict=critical\n');
console.error(
  `${critical.length} critical finding(s) — blocking (auto-fix disabled or already attempted on this HEAD).`
);
process.exit(1);
