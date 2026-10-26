/**
 * WA-SHARED-FREE-1, workspace side. A service reply on the shared (platform-paid) number is charged at the normal service rate during
 * the month. At month close the `shared_number_trueup` task (1) reports this workspace's service charges per number to D1, then (2) once
 * the operator has published the month's true-up for a number (what Meta really billed vs what all workspaces were charged), credits
 * this workspace its pro-rata share of the difference as one `meta_adjust` row, ref `trueup:<yyyy-mm>:<workspace>`. Pro-rata is to
 * billable service replies; the share is rounded half-even once, so the shares can differ from the pool by a piaster or two.
 */
import type { Env } from '../../env';
import { addTask } from '../scheduler';
import type { Billing } from './engine';
import { roundHalfEvenDiv } from './money';
import { monthRange } from './statement';
import { alert } from '../observability';

type Sql = DurableObjectStorage['sql'];
const DAY = 86_400_000;
/** How long after month close the task keeps waiting for the operator's true-up before it alerts and stops. */
export const TRUEUP_WAIT_DAYS = 25;

export const monthOf = (t: number): string => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' }).formatToParts(t);
  return `${f.find((p) => p.type === 'year')!.value}-${f.find((p) => p.type === 'month')!.value}`;
};

/** Makes sure this month's close task exists (one per month; the payload names the month). */
export function ensureTrueupTask(sql: Sql, now: number): void {
  const month = monthOf(now);
  const have = sql.exec("SELECT 1 FROM scheduled_tasks WHERE kind = 'shared_number_trueup' AND json_extract(payload, '$.month') = ?", month).toArray().length;
  if (have) return;
  const end = monthRange(month)!.to;
  addTask(sql, 'shared_number_trueup', end + 2 * 3_600_000, { month });
}

type Usage = { number_id: string; minor: number; n: number };

export function usageFor(sql: Sql, month: string): Usage[] {
  const r = monthRange(month);
  if (!r) return [];
  return sql.exec<Usage>(
    `SELECT bs.number_id AS number_id, -sum(wl.amount_minor) AS minor, count(*) AS n
       FROM wallet_ledger wl JOIN billable_sends bs ON bs.wamid = wl.wamid
      WHERE wl.kind = 'meta_charge' AND wl.category = 'service' AND bs.funding = 'platform_line' AND wl.at >= ? AND wl.at < ? AND bs.number_id IS NOT NULL
      GROUP BY bs.number_id`, r.from, r.to,
  ).toArray();
}

/** Runs the task. Returns when to try again (the operator has not published yet) or null when finished. */
export async function runTrueup(env: Env, sql: Sql, billing: Billing, tx: <R>(f: () => R) => R, workspaceId: string, month: string, now: number): Promise<number | null> {
  const usage = usageFor(sql, month);
  if (!usage.length) return null;
  await env.DB.batch(usage.map((u) => env.DB.prepare('INSERT OR REPLACE INTO shared_number_usage (month, phone_number_id, workspace_id, charged_minor, service_count, reported_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(month, u.number_id, workspaceId, u.minor, u.n, now)));
  let share = 0;
  let missing = 0;
  for (const u of usage) {
    const t = await env.DB.prepare('SELECT rebate_minor, total_count FROM shared_trueups WHERE month = ? AND phone_number_id = ?').bind(month, u.number_id).first<{ rebate_minor: number; total_count: number }>();
    if (!t) {
      missing++;
      continue;
    }
    if (t.total_count > 0 && t.rebate_minor > 0) share += Number(roundHalfEvenDiv(BigInt(t.rebate_minor) * BigInt(u.n), BigInt(t.total_count)));
  }
  if (missing) {
    const end = monthRange(month)!.to;
    if (now > end + TRUEUP_WAIT_DAYS * DAY) {
      alert('shared_trueup_not_published', { workspace: workspaceId, month });
      return null;
    }
    return now + DAY;
  }
  if (share > 0) tx(() => billing.post({ kind: 'meta_adjust', netMinor: share, ref: `trueup:${month}:${workspaceId}`, now, note: `shared-number true-up ${month}` }));
  return null;
}

/**
 * Our own figure for what Meta bills, from the billing flags on the messages themselves, to compare with the number Meta's pricing
 * analytics reports. The difference is an alert (never auto-corrected): either side can be the one that is wrong.
 */
export function metaCostUsdMicros(sql: Sql, month: string): { numberId: string; usdMicros: number; messages: number }[] {
  const r = monthRange(month);
  if (!r) return [];
  return sql.exec<{ numberId: string; usdMicros: number; messages: number }>(
    `SELECT number_id AS numberId, coalesce(sum(cost_usd_micros), 0) AS usdMicros, count(*) AS messages FROM billable_sends
      WHERE funding = 'platform_line' AND billable = 1 AND delivered_at >= ? AND delivered_at < ? GROUP BY number_id`, r.from, r.to,
  ).toArray();
}
