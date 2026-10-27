#!/usr/bin/env node
// Checks a deployment from the outside after every deploy: the running commit, security headers, Meta's webhook handshake and
// signature check. A check it cannot run is reported as SKIPPED with the reason, never as passed.
//
// Usage: node scripts/verify-prod.mjs --base https://wa.ebda.app --expect "$(git rev-parse --short origin/main)" --brand ebda
// --peer-health <url> is the other suite Worker's /health (Ebda Store): proves SUITE_BUYER_KEY_SECRET is equal on both by comparing a derived vector.
// --brand is the brand the deployment must serve: the page's /brand.json must say so and, for any brand but ebda, its CSP must name no ebda.app host.
// Optional secrets come from the environment only (never argv, which lands in shell history):
//   META_VERIFY_TOKEN  → runs the webhook handshake check
//   META_APP_SECRET    → sends one signed, empty webhook (no side effects) and expects 200
//   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (+ --cron "<expr>" --worker <name>) → prints the LIVE cron schedule and requires the expected one
import { createHmac, randomUUID } from 'node:crypto';

/** @returns {Promise<{ name: string; ok: boolean | null; detail: string }[]>} ok: true = passed, false = failed, null = skipped */
export async function runChecks({ base, expectCommit, expectBrand, peerHealth, verifyToken, appSecret, expectCron, worker, cfToken, cfAccount, fetchImpl = fetch }) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  const get = (path, init) => fetchImpl(`${base}${path}`, { redirect: 'manual', ...init });

  let health = null;
  try {
    const res = await get('/health');
    const body = await res.json().catch(() => null);
    health = res.ok ? body : null;
    const why = body?.status === 'misconfigured' ? 'misconfigured: a secret is missing or malformed (see the secret_misconfigured alert in the Worker logs)' : `status ${res.status}`;
    add('health', health?.ok === true, health ? `service ${health.service}` : why);
    const sec = res.headers.get('strict-transport-security') && res.headers.get('x-content-type-options') === 'nosniff';
    add('api security headers', !!sec, sec ? 'hsts + nosniff' : 'missing strict-transport-security or nosniff on /health');
  } catch (e) {
    add('health', false, `unreachable: ${e.message}`);
  }
  if (!expectCommit) add('health commit', null, 'skipped: pass --expect <commit> (tip of main) to prove what is deployed');
  // An empty running commit would satisfy startsWith('') for ANY expected commit: it proves nothing, so it fails.
  else if (health) add('health commit', !!health.commit && (String(health.commit).startsWith(expectCommit) || expectCommit.startsWith(String(health.commit))), `running ${health.commit || '(empty)'}, expected ${expectCommit}`);
  else add('health commit', false, 'no health answer');

  // D4: SUITE_BUYER_KEY_SECRET must be identical on this Worker and on Ebda Store. Each publishes a value DERIVED from it on /health (16 hex of an HMAC over a
  // fixed non-phone string); the two are compared here. The secret is never an input of this script and never printed, and neither is the vector.
  {
    const name = 'suite buyer key equal on both Workers';
    if (!peerHealth) add(name, null, 'skipped: pass --peer-health <url of the other Worker\'s /health> (Ebda Store)');
    else {
      const own = health?.buyerKeyVector;
      let peer = null;
      try { peer = (await (await fetchImpl(peerHealth, { redirect: 'manual' })).json().catch(() => null))?.buyerKeyVector ?? null; } catch { /* reported below */ }
      if (typeof own !== 'string' || !own) add(name, false, 'this Worker publishes no buyerKeyVector: SUITE_BUYER_KEY_SECRET is not set (or /health is down)');
      else if (typeof peer !== 'string' || !peer) add(name, null, 'skipped: the other Worker is unreachable or does not publish buyerKeyVector yet (it must add the same field, see docs/launch/README.md)');
      else add(name, own === peer, own === peer ? 'both Workers derive the same buyer key' : 'the two Workers derive DIFFERENT buyer keys: set SUITE_BUYER_KEY_SECRET to the same value on both, or every customer is two people');
    }
  }

  try {
    const res = await get('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    add('page security headers', res.ok && csp.includes("frame-ancestors 'none'"), csp ? 'csp present' : `no CSP on / (status ${res.status})`);
    if (!expectBrand) add('page CSP names no other brand', null, 'skipped: pass --brand <brand> (the brand this deployment must serve)');
    else if (expectBrand === 'ebda') add('page CSP names no other brand', true, 'suite brand: its own hosts are expected');
    else add('page CSP names no other brand', !/ebda\.app/i.test(csp), /ebda\.app/i.test(csp) ? 'the page CSP names an ebda.app host: this is the suite brand\'s page' : 'no suite host in the CSP');
  } catch (e) {
    add('page security headers', false, `unreachable: ${e.message}`);
  }

  if (!expectBrand) add('web build brand', null, 'skipped: pass --brand <brand>');
  else {
    try {
      const res = await get('/brand.json');
      const built = res.ok ? (await res.json()).brand : null;
      add('web build brand', built === expectBrand, built ? `page built for "${built}", expected "${expectBrand}"` : 'no /brand.json: the page was built before brand stamping, or is not this product\'s page');
    } catch {
      add('web build brand', false, 'no readable /brand.json');
    }
  }

  const challenge = randomUUID();
  if (!verifyToken) add('webhook handshake', null, 'skipped: set META_VERIFY_TOKEN');
  else {
    const res = await get(`/meta/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challenge}`);
    const body = await res.text();
    add('webhook handshake', res.status === 200 && body === challenge, `status ${res.status}`);
  }
  const bad = await get(`/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong-${challenge}&hub.challenge=${challenge}`);
  add('webhook refuses a wrong verify token', bad.status === 403, `status ${bad.status}`);

  const empty = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
  const unsigned = await get('/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: empty });
  add('webhook refuses unsigned', unsigned.status === 401, `status ${unsigned.status}`);
  // The card provider's webhook must reach the Worker (wrangler run_worker_first has /kashier/*). If the SPA fallback answered instead, no payment
  // would ever be confirmed: an unsigned POST must get the Worker's 4xx (text or JSON), never 200 / HTML.
  try {
    const k = await get('/kashier/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const kBody = (await k.text()).trimStart();
    const html = /text\/html/i.test(k.headers.get('content-type') ?? '') || kBody.startsWith('<');
    add('kashier webhook is served by the Worker', k.status >= 400 && k.status < 500 && !html, html ? `status ${k.status}, an HTML page: the static assets answered, /kashier/* is missing from run_worker_first` : `status ${k.status}`);
  } catch (e) {
    add('kashier webhook is served by the Worker', false, `unreachable: ${e.message}`);
  }
  // Meta's data-deletion callback (B9) must reach the Worker too: an unsigned form post gets the Worker's 400 JSON, never the SPA's HTML.
  try {
    const d = await get('/meta/data-deletion', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'signed_request=invalid' });
    const dBody = (await d.text()).trimStart();
    const dHtml = /text\/html/i.test(d.headers.get('content-type') ?? '') || dBody.startsWith('<');
    add('data-deletion callback is served by the Worker and refuses an unsigned post', d.status === 400 && !dHtml, dHtml ? `status ${d.status}, an HTML page: /meta/* is not reaching the Worker` : `status ${d.status}`);
  } catch (e) {
    add('data-deletion callback is served by the Worker and refuses an unsigned post', false, `unreachable: ${e.message}`);
  }
  if (!appSecret) add('webhook accepts signed', null, 'skipped: set META_APP_SECRET');
  else {
    const sig = `sha256=${createHmac('sha256', appSecret).update(empty).digest('hex')}`;
    const signed = await get('/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: empty });
    add('webhook accepts signed', signed.status === 200, `status ${signed.status}`);
  }

  // The daily cron cannot be waited on, so its REGISTRATION is proven from Cloudflare's API (not assumed from wrangler.jsonc): the live schedules of the
  // Worker are printed, and the expected one must be among them. The first real tick is proven by the next run's `daily_billing` log line (docs/runbooks/rollback.md).
  if (!expectCron) add('cron schedule registered live', null, 'skipped: pass --cron "<expression>" (the schedule wrangler.jsonc registers)');
  else if (!cfToken || !cfAccount || !worker) add('cron schedule registered live', null, 'skipped: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID and pass --worker <name>');
  else {
    try {
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/scripts/${worker}/schedules`, { headers: { authorization: `Bearer ${cfToken}` } });
      const body = res.ok ? await res.json().catch(() => null) : null;
      const live = (body?.result?.schedules ?? []).map((s) => s.cron);
      if (!body?.success) add('cron schedule registered live', false, `could not read the live schedule (status ${res.status})`);
      else add('cron schedule registered live', live.includes(expectCron), `live schedule: ${live.length ? live.map((c) => `"${c}"`).join(', ') : '(none)'}; expected "${expectCron}"`);
    } catch (e) {
      add('cron schedule registered live', false, `unreachable: ${e.message}`);
    }
  }
  return out;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const base = arg('--base');
  if (!base || !/^https:\/\//.test(base)) {
    console.error('usage: node scripts/verify-prod.mjs --base https://<host> [--expect <commit>] [--brand <brand>]');
    process.exit(2);
  }
  const results = await runChecks({ base: base.replace(/\/$/, ''), expectCommit: arg('--expect'), expectBrand: arg('--brand'), peerHealth: arg('--peer-health'), verifyToken: process.env.META_VERIFY_TOKEN, appSecret: process.env.META_APP_SECRET, expectCron: arg('--cron'), worker: arg('--worker'), cfToken: process.env.CLOUDFLARE_API_TOKEN, cfAccount: process.env.CLOUDFLARE_ACCOUNT_ID });
  for (const r of results) console.log(`${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP'}  ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\n${failed ? 'NOT VERIFIED' : skipped ? 'VERIFIED (with skips: see SKIP lines for what was not checked)' : 'VERIFIED'}`);
  process.exit(failed ? 1 : 0);
}
