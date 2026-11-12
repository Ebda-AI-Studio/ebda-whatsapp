/**
 * WA-FX-DAILY-1: the daily USD->EGP rate. Cron (`scheduled`, beside `dailyBilling`) fetches the rate and APPENDS one `fx_rates` row per UTC day.
 *  - Source: fawazahmed0 currency-api (jsDelivr, then its Cloudflare Pages mirror); fallback open.er-api.com (one call a day, attribution in docs).
 *  - Every response is Zod-validated; a malformed one counts as a failed source, never as a rate.
 *  - Sanity band: a move of more than FX_BAND_PCT against the newest stored rate is NOT inserted; `fx_rate_rejected` carries the observed value (the
 *    external fact is recorded in the alert, the price keeps the last rate until an operator publishes through POST /fx-rates).
 *  - Fetch failure keeps the last rate (`fx_fetch_failed`); the newest row older than 48 h raises `fx_rate_stale`.
 *  - Rows are effective RATE_LEAD_MS ahead, like every operator publish, so each workspace copy has the version before it applies. A charge is priced
 *    at DELIVERY time, so a lower rate never re-prices a hold quoted earlier (the hold was estimated at the higher rate and its surplus is released).
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { fetchWithTimeout } from '../net/fetch-with-timeout';
import { alert, errClass } from '../observability';
import { audit } from './operator';
import { RATE_LEAD_MS } from './pricing';
import { computeFxBuffer } from './fx-buffer';

export const FX_BAND_PCT = 5;
export const FX_STALE_MS = 48 * 3_600_000;
export const FX_ACTOR = 'system:fx-cron';
const HISTORY_DAYS = 380;

const rateNum = z.number().finite().min(1).max(1000);
const fawaz = z.object({ date: z.string(), usd: z.object({ egp: rateNum }) });
const erApi = z.object({ result: z.literal('success'), rates: z.object({ EGP: rateNum }) });

export const FX_SOURCES = [
  { name: 'fawazahmed0', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', parse: (j: unknown) => fawaz.parse(j).usd.egp },
  { name: 'fawazahmed0-pages', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json', parse: (j: unknown) => fawaz.parse(j).usd.egp },
  { name: 'open.er-api', url: 'https://open.er-api.com/v6/latest/USD', parse: (j: unknown) => erApi.parse(j).rates.EGP },
] as const;

type FetchFn = NonNullable<Parameters<typeof fetchWithTimeout>[3]>;

/** First source that answers with a valid EGP rate, in order; null when all fail. */
export async function fetchEgpPerUsd(fetchFn?: FetchFn): Promise<{ source: string; micros: number } | null> {
  for (const s of FX_SOURCES) {
    try {
      const res = await fetchWithTimeout(s.url, { headers: { accept: 'application/json' } }, { label: `fx.${s.name}` }, fetchFn);
      if (!res.ok) continue;
      return { source: s.name, micros: Math.round(s.parse(await res.json()) * 1e6) };
    } catch { /* next source */ }
  }
  return null;
}

export type FxDailyResult = 'inserted' | 'exists' | 'fetch_failed' | 'rejected';

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10);

export async function dailyFx(env: Env, now = Date.now(), fetchFn?: FetchFn): Promise<FxDailyResult> {
  return insertToday(env, now, fetchFn); // the staleness check is NOT here: it runs from dailyBilling so a broken fetch cannot silence it
}

async function insertToday(env: Env, now: number, fetchFn?: FetchFn): Promise<FxDailyResult> {
  const day = utcDay(now);
  if (await env.DB.prepare('SELECT 1 FROM fx_rates WHERE obs_day = ?').bind(day).first()) return 'exists';
  const got = await fetchEgpPerUsd(fetchFn);
  if (!got) {
    alert('fx_fetch_failed', { sources: FX_SOURCES.length });
    return 'fetch_failed';
  }
  const last = await env.DB.prepare('SELECT egp_per_usd_micros AS m FROM fx_rates ORDER BY effective_from DESC, ver DESC LIMIT 1').first<{ m: number }>();
  if (last) {
    const movePct = (got.micros / last.m - 1) * 100;
    if (Math.abs(movePct) > FX_BAND_PCT) {
      alert('fx_rate_rejected', { source: got.source, observedMicros: got.micros, lastMicros: last.m, movePct: Math.round(movePct * 100) / 100 });
      return 'rejected';
    }
  }
  const hist = await env.DB.prepare('SELECT egp_per_usd_micros AS m FROM fx_rates WHERE obs_day IS NOT NULL AND obs_day < ? ORDER BY obs_day DESC LIMIT ?').bind(day, HISTORY_DAYS).all<{ m: number }>();
  const rates = [...hist.results.map((r) => r.m / 1e6).reverse(), got.micros / 1e6];
  const prev = await env.DB.prepare('SELECT buffer_bps AS b FROM fx_rates ORDER BY effective_from DESC, ver DESC LIMIT 1').first<{ b: number }>();
  const pin = await env.DB.prepare('SELECT buffer_bps AS b FROM fx_buffer_pins ORDER BY id DESC LIMIT 1').first<{ b: number | null }>();
  const buf = computeFxBuffer(rates, prev?.b ?? null, pin?.b ?? null);
  const effectiveFrom = now + RATE_LEAD_MS;
  const ins = await env.DB.prepare(
    "INSERT INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor, source, obs_day, vol_bps, drift_pct, buffer_mode) VALUES ((SELECT coalesce(max(ver), 0) + 1 FROM fx_rates), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).bind(effectiveFrom, got.micros, buf.bufferBps, now, FX_ACTOR, got.source, day, buf.volBps, buf.driftPct, buf.mode).run();
  if (!ins.meta.changes) return 'exists'; // another run won the day
  await audit(env, { actor: FX_ACTOR, action: 'fx_published', after: { egpPerUsdMicros: got.micros, bufferBps: buf.bufferBps, mode: buf.mode, source: got.source, effectiveFrom }, reason: 'daily cron' }, now);
  return 'inserted';
}

/**
 * The newest rate row older than 48 h, or none at all: the price is running on a rate nobody refreshed. Called from `dailyBilling` (the other daily task),
 * deliberately NOT from the fetch job, so it still fires when the fetch job throws, hangs or is removed. A backfill resets the clock once (its rows are new).
 */
export async function checkFxStale(env: Env, now = Date.now()): Promise<void> {
  const r = await env.DB.prepare('SELECT max(published_at) AS p FROM fx_rates').first<{ p: number | null }>();
  if (r?.p == null || now - r.p > FX_STALE_MS) alert('fx_rate_stale', { newestPublishedAt: r?.p ?? null, hours: r?.p == null ? null : Math.round((now - r.p) / 3_600_000) });
}

export async function runDailyFx(env: Env): Promise<void> {
  await dailyFx(env).catch((err) => alert('fx_fetch_failed', { error: errClass(err) }));
}

export async function setFxBufferPin(env: Env, a: { actor: string; bufferBps: number | null; reason: string }, now = Date.now()): Promise<{ bufferBps: number | null }> {
  const before = await env.DB.prepare('SELECT buffer_bps AS b FROM fx_buffer_pins ORDER BY id DESC LIMIT 1').first<{ b: number | null }>();
  await env.DB.prepare('INSERT INTO fx_buffer_pins (buffer_bps, actor, created_at) VALUES (?, ?, ?)').bind(a.bufferBps, a.actor, now).run();
  await audit(env, { actor: a.actor, action: 'fx_buffer_pinned', before: { bufferBps: before?.b ?? null }, after: { bufferBps: a.bufferBps }, reason: a.reason }, now);
  return { bufferBps: a.bufferBps };
}

export async function getFxBufferPin(env: Env): Promise<{ bufferBps: number | null; actor: string | null; createdAt: number | null }> {
  const r = await env.DB.prepare('SELECT buffer_bps AS b, actor, created_at FROM fx_buffer_pins ORDER BY id DESC LIMIT 1').first<{ b: number | null; actor: string; created_at: number }>();
  return { bufferBps: r?.b ?? null, actor: r?.actor ?? null, createdAt: r?.created_at ?? null };
}

// ---- one-off backfill (operator route; never automatic) ------------------------------------------------------------------

const DATED_URL = (day: string) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.json`;
const BACKFILL_ACTOR = 'system:fx-backfill';
const BACKFILL_CHUNK = 12;
export const BACKFILL_MAX_DAYS = 400;

export type BackfillResult = { requested: number; fetched: number; missing: number; inserted: number; existing: number; newestDay: string | null; newestBufferBps: number | null };

/**
 * Loads up to `days` daily snapshots (the days BEFORE today's UTC day; the cron owns today) from jsDelivr's dated snapshots so the dynamic buffer has
 * history from day 1. Idempotent (one row per `obs_day`, ON CONFLICT DO NOTHING; a re-run inserts only what is missing). A day whose snapshot is absent,
 * invalid or dated differently is skipped (a gap, counted in `missing`). Historical rows are inputs, not prices: they carry source `backfill`,
 * buffer 700 and mode `backfill`; ONLY the newest inserted row gets the computed buffer (no previous buffer exists, so no fall limit), plus the pin if set.
 * Rows are effective at the start of their own day, so the newest one prices at once and each past day prices late deliveries of that day. Subrequests:
 * `days` fetches + 3 reads + ceil(rows / 50) D1 batches, inside the 1000 a paid Worker allows.
 */
export async function backfillFx(env: Env, a: { days?: number; actor: string; reason: string }, now = Date.now(), fetchFn?: FetchFn): Promise<BackfillResult> {
  const days = Math.min(BACKFILL_MAX_DAYS, Math.max(1, Math.trunc(a.days ?? 365)));
  const today = utcDay(now);
  const wanted = Array.from({ length: days }, (_, i) => utcDay(Date.parse(`${today}T00:00:00Z`) - (days - i) * 86_400_000));
  const have = new Set((await env.DB.prepare('SELECT obs_day AS d FROM fx_rates WHERE obs_day IS NOT NULL').all<{ d: string }>()).results.map((r) => r.d));
  const todo = wanted.filter((d) => !have.has(d));
  const got = new Map<string, number>();
  for (let i = 0; i < todo.length; i += BACKFILL_CHUNK) {
    await Promise.all(todo.slice(i, i + BACKFILL_CHUNK).map(async (day) => {
      try {
        const res = await fetchWithTimeout(DATED_URL(day), { headers: { accept: 'application/json' } }, { label: 'fx.backfill' }, fetchFn);
        if (!res.ok) return;
        const j = fawaz.parse(await res.json());
        if (j.date === day) got.set(day, Math.round(j.usd.egp * 1e6));
      } catch { /* a gap */ }
    }));
  }
  const fetchedDays = [...got.keys()].sort();
  const newest = fetchedDays.at(-1) ?? null;
  // The newest row is the only one that is a price: compute its buffer from everything on file up to it (stored rows and the snapshots just fetched).
  let newestBuffer: { bufferBps: number; volBps: number | null; driftPct: number | null; mode: string } | null = null;
  const lastOnFile = [...have].sort().at(-1) ?? '';
  if (newest && newest > lastOnFile) {
    const stored = (await env.DB.prepare('SELECT obs_day AS d, egp_per_usd_micros AS m FROM fx_rates WHERE obs_day IS NOT NULL AND obs_day < ? ORDER BY obs_day DESC LIMIT ?').bind(newest, HISTORY_DAYS).all<{ d: string; m: number }>()).results;
    const series = new Map<string, number>(stored.map((r) => [r.d, r.m]));
    for (const [d, m] of got) series.set(d, m);
    const ordered = [...series.keys()].sort().map((d) => series.get(d)! / 1e6);
    const pin = await env.DB.prepare('SELECT buffer_bps AS b FROM fx_buffer_pins ORDER BY id DESC LIMIT 1').first<{ b: number | null }>();
    const r = computeFxBuffer(ordered, null, pin?.b ?? null);
    newestBuffer = { bufferBps: r.bufferBps, volBps: r.volBps, driftPct: r.driftPct, mode: r.mode };
  }
  const sql = 'INSERT INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor, source, obs_day, vol_bps, drift_pct, buffer_mode) VALUES ((SELECT coalesce(max(ver), 0) + 1 FROM fx_rates), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING';
  const stmts = fetchedDays.map((d) => {
    const isNewest = newestBuffer !== null && d === newest;
    const b = isNewest ? newestBuffer! : { bufferBps: 700, volBps: null, driftPct: null, mode: 'backfill' };
    return env.DB.prepare(sql).bind(Date.parse(`${d}T00:00:00Z`), got.get(d)!, b.bufferBps, now, BACKFILL_ACTOR, 'backfill', d, b.volBps, b.driftPct, b.mode);
  });
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += 50) for (const r of await env.DB.batch(stmts.slice(i, i + 50))) inserted += r.meta.changes ?? 0;
  const out: BackfillResult = { requested: days, fetched: got.size, missing: todo.length - got.size, inserted, existing: wanted.length - todo.length, newestDay: newest, newestBufferBps: newestBuffer?.bufferBps ?? null };
  if (inserted) await audit(env, { actor: a.actor, action: 'fx_backfilled', after: { ...out }, reason: a.reason }, now);
  return out;
}
