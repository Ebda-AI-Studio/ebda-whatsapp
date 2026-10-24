#!/usr/bin/env node
// Prints p50/p95/p99 per pipeline stage from Analytics Engine (dataset ebda_wa_usage) as JSON.
// Usage: CF_ACCOUNT_ID=... CF_API_TOKEN=... node scripts/latency-report.mjs --hours 2
// Token permission: Account | Account Analytics | Read.
const hours = Number(process.argv[process.argv.indexOf('--hours') + 1] || 2);
const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
if (!CF_ACCOUNT_ID || !CF_API_TOKEN) {
  console.error('set CF_ACCOUNT_ID and CF_API_TOKEN');
  process.exit(2);
}
if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) {
  console.error('--hours must be between 0 and 744');
  process.exit(2);
}

// double1 = ms since Meta's message timestamp (second precision), double2 = ms since webhook receipt.
const q = (col, p) => `quantileExactWeighted(${p}, ${col}, _sample_interval)`;
const sql = `
SELECT blob1 AS stage,
  SUM(_sample_interval) AS n,
  ${q('double1', 0.5)} AS meta_p50, ${q('double1', 0.95)} AS meta_p95, ${q('double1', 0.99)} AS meta_p99,
  ${q('double2', 0.5)} AS recv_p50, ${q('double2', 0.95)} AS recv_p95, ${q('double2', 0.99)} AS recv_p99
FROM ebda_wa_usage
WHERE timestamp > NOW() - INTERVAL '${Math.ceil(hours)}' HOUR
GROUP BY stage
ORDER BY stage
FORMAT JSON`;

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/analytics_engine/sql`, {
  method: 'POST',
  headers: { authorization: `Bearer ${CF_API_TOKEN}` },
  body: sql,
});
const text = await res.text();
if (!res.ok) {
  console.error(`analytics engine ${res.status}: ${text.slice(0, 500)}`);
  process.exit(1);
}
const { data } = JSON.parse(text);
console.log(JSON.stringify({ hours, generatedAt: new Date().toISOString(), stages: data }, null, 2));
