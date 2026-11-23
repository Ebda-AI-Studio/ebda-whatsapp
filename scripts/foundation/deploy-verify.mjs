#!/usr/bin/env node
// Proves a Cloudflare Worker deploy from the OUTSIDE, with the four checks that a green merge never implies (docs/standard/deploy-verify, rule F):
//   1. deploy job green   every GitHub Actions run for the commit whose workflow contains --workflow is COMPLETED + SUCCESS (a cancelled run is a deploy that did not happen)
//   2. health commit      GET <base>/health answers ok and its `commit` is the commit under test (retried while the edge still serves the previous version)
//   3. live schedules     the Worker's schedules on Cloudflare equal the crons in --wrangler / --cron (the API, never the config file, is the evidence)
//   4. one tick seen      Cloudflare recorded a scheduled invocation of the Worker within --tick-window-min
// usage: node deploy-verify.mjs --base https://host --expect <commit> --repo OWNER/NAME --workflow <name-or-path-substring> --worker <name> --wrangler <file> [--cron "<expr>" ...] [--tick-window-min 60] [--strict]
//   secrets from the environment only: GH_TOKEN (check 1), CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (checks 3-4).
// A check that cannot run is SKIP with its reason, never PASS; --strict turns every SKIP into a failure. Exit 0 = nothing failed, 1 = a check failed (or skipped under --strict), 2 = usage.
// Nothing is written to production: GETs and one read-only GraphQL query. Plain Node >= 20, no dependencies.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cronsFromWrangler } from './cron-lint.mjs';

const GH = 'https://api.github.com';
const CF = 'https://api.cloudflare.com/client/v4';

/** @returns {Promise<{ name: string; ok: boolean | null; detail: string }[]>} ok: true = passed, false = failed, null = skipped */
export async function runChecks({ base, expectCommit, repo, workflow, worker, crons = [], tickWindowMin = 60, ghToken, cfToken, cfAccount, fetchImpl = fetch, now = Date.now }) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  const json = async (url, init) => {
    const res = await fetchImpl(url, init);
    return { res, body: await res.json().catch(() => null) };
  };

  // 1. deploy job green
  // argv shapes are validated up front: they end up in a URL and a comparison, never in a pattern
  if (expectCommit && !/^[0-9a-f]{7,40}$/.test(expectCommit)) throw new Error('--expect must be a 7-40 character lowercase hex commit');
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo must look like OWNER/NAME');
  if (!expectCommit || !repo || !workflow) add('deploy job green', null, 'skipped: pass --expect <commit>, --repo OWNER/NAME and --workflow <name-or-path-substring>');
  else if (!ghToken) add('deploy job green', null, 'skipped: set GH_TOKEN (read access to the repo\'s Actions)');
  else {
    try {
      const { res, body } = await json(`${GH}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(expectCommit)}&per_page=100`, { headers: { authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github+json' } });
      // plain case-insensitive substring match: --workflow is never compiled into a RegExp (regex injection / ReDoS from argv)
      const needle = workflow.toLowerCase();
      const runs = (body?.workflow_runs ?? []).filter((r) => String(r.name ?? '').toLowerCase().includes(needle) || String(r.path ?? '').toLowerCase().includes(needle));
      // the latest run of each workflow decides (a cancelled run followed by a green re-run is green)
      const latest = new Map();
      for (const r of runs) if (!latest.has(r.workflow_id) || r.run_number > latest.get(r.workflow_id).run_number) latest.set(r.workflow_id, r);
      const bad = [...latest.values()].filter((r) => r.status !== 'completed' || r.conclusion !== 'success');
      if (!res.ok) add('deploy job green', false, `could not read the runs (status ${res.status})`);
      else if (latest.size === 0) add('deploy job green', false, `no workflow run whose name or path contains "${workflow}" for ${expectCommit.slice(0, 9)}: the deploy never started`);
      else if (bad.length) add('deploy job green', false, bad.map((r) => `${r.name}: ${r.status}/${r.conclusion ?? 'none'}`).join('; '));
      else add('deploy job green', true, `${latest.size} run(s) completed + success: ${[...latest.values()].map((r) => r.name).join(', ')}`);
    } catch (e) {
      add('deploy job green', false, `unreachable: ${e.message}`);
    }
  }

  // 2. health commit
  if (!base) add('health commit', null, 'skipped: pass --base https://<host>');
  else {
    try {
      const { res, body } = await json(`${base}/health`, { redirect: 'manual' });
      const running = body?.commit ? String(body.commit) : '';
      if (!res.ok || body?.ok === false) add('health commit', false, `/health answered status ${res.status}${body?.status ? ` (${body.status})` : ''}`);
      else if (!expectCommit) add('health commit', null, 'skipped: pass --expect <commit> (tip of main) to prove what is deployed');
      // an empty running commit would satisfy startsWith('') for ANY expected commit: it proves nothing, so it fails
      else if (!running) add('health commit', false, 'running commit is empty (the build was not told its commit): UNKNOWN, check the deploymentId');
      else add('health commit', running.startsWith(expectCommit) || expectCommit.startsWith(running), `running ${running}, expected ${expectCommit}`);
    } catch (e) {
      add('health commit', false, `unreachable: ${e.message}`);
    }
  }

  // 3. live schedules
  const cfReady = cfToken && cfAccount && worker;
  if (crons.length === 0) add('live schedules match', null, 'skipped: the Worker has no schedules in --wrangler / --cron');
  else if (!cfReady) add('live schedules match', null, 'skipped: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID and pass --worker <name>');
  else {
    try {
      const { res, body } = await json(`${CF}/accounts/${cfAccount}/workers/scripts/${worker}/schedules`, { headers: { authorization: `Bearer ${cfToken}` } });
      if (!res.ok || !body?.success) add('live schedules match', false, `could not read the live schedules (status ${res.status})`);
      else {
        const live = new Set((body.result?.schedules ?? []).map((s) => s.cron));
        const want = new Set(crons);
        const missing = [...want].filter((c) => !live.has(c));
        const extra = [...live].filter((c) => !want.has(c));
        add('live schedules match', missing.length === 0 && extra.length === 0, missing.length || extra.length ? `missing live: ${missing.map((c) => `"${c}"`).join(', ') || '(none)'}; live but not in config: ${extra.map((c) => `"${c}"`).join(', ') || '(none)'}` : `${live.size} live schedule(s) equal the config`);
      }
    } catch (e) {
      add('live schedules match', false, `unreachable: ${e.message}`);
    }
  }

  // 4. one tick seen (Cloudflare analytics: workersInvocationsScheduled)
  if (crons.length === 0) add('one tick seen', null, 'skipped: the Worker has no schedules');
  else if (!cfReady) add('one tick seen', null, 'skipped: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID and pass --worker <name>');
  else {
    try {
      const since = new Date(now() - tickWindowMin * 60_000).toISOString();
      const query = 'query($acc:String!,$script:String!,$since:Time!){viewer{accounts(filter:{accountTag:$acc}){workersInvocationsScheduled(limit:50,filter:{scriptName:$script,datetime_geq:$since}){sum{requests} dimensions{status cron}}}}}';
      const { res, body } = await json(`${CF}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${cfToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { acc: cfAccount, script: worker, since } }) });
      const rows = body?.data?.viewer?.accounts?.[0]?.workersInvocationsScheduled;
      if (!res.ok || body?.errors || !Array.isArray(rows)) add('one tick seen', false, `could not read the invocation analytics (status ${res.status})`);
      else {
        const total = rows.reduce((n, r) => n + (r.sum?.requests ?? 0), 0);
        const okCount = rows.filter((r) => r.dimensions?.status === 'success').reduce((n, r) => n + (r.sum?.requests ?? 0), 0);
        add('one tick seen', okCount > 0, `${total} scheduled invocation(s) in the last ${tickWindowMin} min, ${okCount} succeeded`);
      }
    } catch (e) {
      add('one tick seen', false, `unreachable: ${e.message}`);
    }
  }
  return out;
}

/** The "health commit" check is retried while the edge still serves the previous version; every other failure is a real defect and is NOT retried. */
export async function runUntilRolledOut(runOnce, { windowMs = 180_000, intervalMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} } = {}) {
  const started = now();
  for (let attempt = 1; ; attempt++) {
    const results = await runOnce();
    const stale = results.some((r) => r.name === 'health commit' && r.ok === false && /^running /.test(r.detail));
    if (!stale) return results;
    if (now() - started + intervalMs > windowMs) return results;
    log(`attempt ${attempt}: ${results.find((r) => r.name === 'health commit').detail}; the new version is not live yet, retrying in ${intervalMs / 1000}s`);
    await sleep(intervalMs);
  }
}

/** Verdict: 'NOT VERIFIED' (a check failed, or skipped under strict), 'VERIFIED (with skips)' or 'VERIFIED'. */
export function verdict(results, strict = false) {
  const failed = results.filter((r) => r.ok === false).length + (strict ? results.filter((r) => r.ok === null).length : 0);
  const skipped = results.filter((r) => r.ok === null).length;
  return { failed, skipped, text: failed ? 'NOT VERIFIED' : skipped ? 'VERIFIED (with skips: see SKIP lines for what was not checked)' : 'VERIFIED' };
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const all = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const base = arg('--base');
  if (base && !/^https:\/\//.test(base)) {
    console.error('usage: node deploy-verify.mjs --base https://<host> --expect <commit> --repo OWNER/NAME --workflow <name-or-path-substring> --worker <name> --wrangler <file> [--cron "<expr>" ...] [--tick-window-min 60] [--strict]');
    process.exit(2);
  }
  const wrangler = arg('--wrangler');
  const crons = [...(wrangler ? cronsFromWrangler(readFileSync(wrangler, 'utf8'), wrangler) : []), ...all('--cron')];
  const opts = { base: base?.replace(/\/$/, ''), expectCommit: arg('--expect'), repo: arg('--repo'), workflow: arg('--workflow'), worker: arg('--worker'), crons, tickWindowMin: Number(arg('--tick-window-min') ?? 60), ghToken: process.env.GH_TOKEN, cfToken: process.env.CLOUDFLARE_API_TOKEN, cfAccount: process.env.CLOUDFLARE_ACCOUNT_ID };
  const results = await runUntilRolledOut(() => runChecks(opts), { windowMs: Number(process.env.VERIFY_WINDOW_S ?? 180) * 1000, intervalMs: Number(process.env.VERIFY_INTERVAL_S ?? 5) * 1000, log: (m) => console.error(m) });
  for (const r of results) console.log(`${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP'}  ${r.name}: ${r.detail}`);
  const v = verdict(results, argv.includes('--strict'));
  console.log(`\n${v.text}`);
  process.exit(v.failed ? 1 : 0);
}
