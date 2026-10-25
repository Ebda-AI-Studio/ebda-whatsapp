/**
 * Bot results: how many customers reach each step of the WhatsApp ordering flow, per day, with no personal data.
 *
 * A customer is counted by a per-day token, HMAC(that day's random salt, wa id). The salt lives only until the day is rolled up, so a token
 * cannot be reversed (a salted keyed hash of a phone is only as safe as the salt) and cannot be joined with another day's. Rows carry the
 * Cairo calendar day, a step and the token; the rollup keeps counts only and deletes the day's markers and salt. (day, step, token) is the
 * primary key, so a replayed turn or a Meta redelivery can never count twice. Erasing a customer deletes their unrolled markers.
 */
import { nextLocalHour } from './backup';
import { FUNNEL_STEPS, type BotFunnelDto } from './api/contract';
import { addTask } from './scheduler';
import type { LinkHost } from './store-link/host';

export { FUNNEL_STEPS };
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
/** Funnel steps in the order of the flow (the side steps are reported apart). */
export const FUNNEL_MAIN: readonly FunnelStep[] = ['conversation', 'browse', 'cart', 'checkout', 'order'];
export const FUNNEL_TIME_ZONE = 'Africa/Cairo';
/** The rollup runs at 01:00 local: 00:00 does not exist on the night the clocks move forward. */
const ROLLUP_HOUR_LOCAL = 1;

let dayFormat: Intl.DateTimeFormat | undefined;
/** The calendar day (YYYY-MM-DD) on the wall clock of Cairo at `ms`. From Intl, never a fixed offset, so both clock changes need no special case. */
export function cairoDay(ms: number): string {
  dayFormat ??= new Intl.DateTimeFormat('en-GB', { timeZone: FUNNEL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(dayFormat.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function saltFor(sql: SqlStorage, day: string): string {
  const fresh = hex(crypto.getRandomValues(new Uint8Array(32)));
  sql.exec('INSERT OR IGNORE INTO bot_funnel_salt (day, salt) VALUES (?, ?)', day, fresh);
  return sql.exec<{ salt: string }>('SELECT salt FROM bot_funnel_salt WHERE day = ?', day).one().salt;
}

async function tokenOf(salt: string, waId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(waId))).slice(0, 16));
}

/**
 * Counts `waId` at `step` for the Cairo day of `now`. True when this is the first time today. `skip` is checked right before the write, with no
 * await in between (a customer erased or opted out while the token was computed leaves nothing). Schedules the rollup; the caller arms the alarm.
 */
export async function recordFunnelStep(sql: SqlStorage, a: { step: FunnelStep; waId: string; now: number; skip?: () => boolean }): Promise<boolean> {
  const day = cairoDay(a.now);
  const token = await tokenOf(saltFor(sql, day), a.waId);
  if (a.skip?.()) return false;
  const wrote = sql.exec('INSERT OR IGNORE INTO bot_funnel_markers (day, step, token) VALUES (?, ?, ?)', day, a.step, token).rowsWritten > 0;
  if (wrote) addTask(sql, 'funnel_rollup', nextLocalHour(a.now, ROLLUP_HOUR_LOCAL, FUNNEL_TIME_ZONE));
  return wrote;
}

/** `recordFunnelStep` for a turn: also points the alarm at the rollup the first time (a no-op write otherwise). Never throws into the customer's turn. */
export async function recordFunnel(host: Pick<LinkHost, 'sql' | 'arm'>, a: { step: FunnelStep; waId: string; now: number; skip?: () => boolean }): Promise<void> {
  if (await recordFunnelStep(host.sql, a)) await host.arm();
}

/**
 * Turns every day before today into counts and deletes those days' markers and salts, in one step (idempotent). Returns when to run again
 * (today still has markers), or undefined.
 */
export function funnelRollup(sql: SqlStorage, now: number): number | undefined {
  const today = cairoDay(now);
  sql.exec(
    `INSERT INTO bot_funnel_daily (day, step, customers) SELECT day, step, count(*) FROM bot_funnel_markers WHERE day < ? GROUP BY day, step
     ON CONFLICT(day, step) DO UPDATE SET customers = customers + excluded.customers`, today,
  );
  sql.exec('DELETE FROM bot_funnel_markers WHERE day < ?', today);
  sql.exec('DELETE FROM bot_funnel_salt WHERE day < ?', today);
  const left = sql.exec<{ n: number }>('SELECT count(*) AS n FROM bot_funnel_markers').one().n;
  return left > 0 ? nextLocalHour(now, ROLLUP_HOUR_LOCAL, FUNNEL_TIME_ZONE) : undefined;
}

/** Erases a customer's markers: for each day whose salt still exists, recompute their token and delete it. Counts already rolled up stay. */
export async function eraseFunnelMarkers(sql: SqlStorage, waId: string): Promise<void> {
  for (const { day, salt } of sql.exec<{ day: string; salt: string }>('SELECT day, salt FROM bot_funnel_salt').toArray()) {
    sql.exec('DELETE FROM bot_funnel_markers WHERE day = ? AND token = ?', day, await tokenOf(salt, waId));
  }
}

/** Counts per step and day for `from`..`to` (Cairo days, inclusive): the rolled-up days plus the markers not yet rolled up (today, and any day awaiting its rollup). */
export function readFunnel(sql: SqlStorage, from: string, to: string): BotFunnelDto {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  const at = new Map(days.map((d, i) => [d, i]));
  const series = new Map<string, number[]>(FUNNEL_STEPS.map((s) => [s, days.map(() => 0)]));
  const add = (r: { day: string; step: string; n: number }) => {
    const i = at.get(r.day);
    const row = series.get(r.step);
    if (i !== undefined && row) row[i]! += r.n;
  };
  for (const r of sql.exec<{ day: string; step: string; n: number }>('SELECT day, step, customers AS n FROM bot_funnel_daily WHERE day BETWEEN ? AND ?', from, to).toArray()) add(r);
  for (const r of sql.exec<{ day: string; step: string; n: number }>('SELECT day, step, count(*) AS n FROM bot_funnel_markers WHERE day BETWEEN ? AND ? GROUP BY day, step', from, to).toArray()) add(r);
  return { from, to, days, steps: FUNNEL_STEPS.map((step) => ({ step, series: series.get(step)!, total: series.get(step)!.reduce((a, b) => a + b, 0) })) };
}
