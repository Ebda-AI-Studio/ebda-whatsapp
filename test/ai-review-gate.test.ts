import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { isRisky, riskyPaths } from '../.github/ai-review/risky-paths.mjs';

// Ruling WA-AI-REVIEW-1: every PR to ebda-whatsapp is reviewed by the same independent AI gate as ebda-store (copied from it, jobs
// identical), because the review-gated merge rule needs an `ai-review-passed` that something other than the author can set. Before
// this the repo had NO review workflow, so a PR could merge on CI alone. The gate runs from the BASE branch, on the light runners.
const wf = readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8');
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('ai-review classifier (fail closed: only docs, markdown and NEWLY ADDED tests are exempt)', () => {
  it('exempts markdown and docs/ whatever the status', () => {
    for (const p of ['README.md', 'docs/plans/x.md', 'docs/img/a.png'])
      for (const st of ['A', 'M', 'D']) expect(isRisky(p, st), `${st} ${p}`).toBe(false);
  });
  it('exempts a newly ADDED test file', () => {
    for (const p of ['test/new-feature.test.ts', 'web/src/x.test.tsx']) expect(isRisky(p, 'A'), p).toBe(false);
  });
  it("a MODIFIED, DELETED or unknown-status test is risky: this repo's safety guards are test files", () => {
    for (const f of ['test/guards.test.ts', 'test/consent.test.ts', 'test/request-guards.test.ts', 'test/ai-mask-guard.test.ts'])
      for (const st of ['M', 'D', '?']) expect(isRisky(f, st), `${st} ${f}`).toBe(true);
  });
  it('requires review for the money, consent, auth and data paths of this repo', () => {
    for (const p of ['src/core/billing.ts', 'src/routes/webhook.ts', 'src/core/consent.ts', 'migrations/0021_x.sql', 'wrangler.jsonc', 'src/env.ts'])
      expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('requires review for the gate itself and CI, so the gate cannot be edited to pass', () => {
    for (const p of ['.github/ai-review/review.mjs', '.github/ai-review/prompt.md', '.github/workflows/ai-review.yml', '.github/workflows/ci.yml', 'package.json'])
      expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('does not let a docs/ or test-looking name smuggle code through', () => {
    for (const p of ['docs/build.mjs', 'src/core/contest.ts', 'src/core/test-utils.ts']) expect(isRisky(p, 'A'), p).toBe(true);
  });
  it('parses git --name-status lines', () => {
    expect(riskyPaths(['A\tREADME.md', 'A\ta.test.ts', ''])).toEqual([]);
    expect(riskyPaths(['M\ttest/guard.test.ts', 'A\ttest/new.test.ts', 'A\tsrc/x.ts'])).toEqual(['test/guard.test.ts', 'src/x.ts']);
  });
});

describe('the workflow', () => {
  it('runs from the base branch on pull_request_target and every job is on the light runners', () => {
    expect(wf).toMatch(/on:\n\s+pull_request_target:/);
    const runs = wf.match(/^\s+runs-on: .*$/gm) ?? [];
    expect(runs.length).toBe(4);
    for (const r of runs) expect(r).toContain("fromJSON(vars.EBDA_LIGHT_RUNS_ON || vars.EBDA_RUNS_ON || '\"ubuntu-24.04\"')");
  });
  it('a label event gets its own concurrency group, so adding a label never cancels a running bot review', () => {
    expect(/^  group: (.*)$/m.exec(wf)?.[1] ?? '').toMatch(/github\.event\.action == 'labeled' && 'label' \|\| 'review'/);
  });
  it('base checkout, 400 KB fails, name-status, fork-gate red until labelled and never given the secret', () => {
    expect((wf.match(/ref: \$\{\{ github\.base_ref \}\}/g) ?? []).length).toBe(2);
    expect(wf).not.toMatch(/head -c/);
    expect(wf).toMatch(/-ge 400000/);
    expect(wf).toMatch(/git diff --name-status --no-renames/);
    const fork = wf.slice(wf.indexOf('  fork-gate:'));
    expect(fork).toMatch(/head\.repo\.full_name != github\.repository/);
    expect(fork).toMatch(/exit 1/);
    expect(fork).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
  it('Ruling AI-REVIEW-LABEL-1: only a real critical verdict may remove ai-review-passed; refusal and infra paths leave labels alone', () => {
    const classify = wf.slice(wf.indexOf('  classify:'), wf.indexOf('  review:'));
    expect(classify).not.toMatch(/remove-label ai-review-passed/);
    const review = wf.slice(wf.indexOf('  review:'), wf.indexOf('  manual-pass:'));
    const step = review.slice(review.indexOf('- name: Drop ai-review-passed'), review.indexOf('- name: Label ai-review-passed'));
    expect(step).toMatch(/if: always\(\) && steps\.gate\.outputs\.verdict == 'critical'/);
    expect([...wf.matchAll(/--remove-label ai-review-passed/g)].length).toBe(2);
    expect(read('.github/ai-review/review.mjs')).toMatch(/verdict=critical/);
  });
  it('Ruling AI-REVIEW-HANG-1: the reviewer call is bounded and retried once, and two attempts fit inside the job timeout', () => {
    const step = wf.slice(wf.indexOf('- name: Review the diff'), wf.indexOf('- name: Post findings and gate'));
    expect(step).toMatch(/timeout (\d+) claude -p/);
    expect(step).toMatch(/for attempt in 1 2; do/);
    expect(step.trimEnd()).toMatch(/exit 1$/);
    const per = Number(/timeout (\d+) claude -p/.exec(step)?.[1]);
    const jobTimeout = Number(/review:[\s\S]*?timeout-minutes:\s*(\d+)/.exec(wf)?.[1]);
    expect(2 * per).toBeLessThan(jobTimeout * 60 - 120);
  });
  it('the jobs match the store copy it was ported from (same gate, same required check names)', () => {
    for (const name of ['AI review classify', 'AI review']) expect(wf).toContain(`name: ${name}`);
  });
});
