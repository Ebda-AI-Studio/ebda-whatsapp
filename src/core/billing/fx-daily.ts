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
  const result = await insertToday(env, now, fetchFn);
  await checkStale(env, now);
  return result;
}

async function insertToday(env: Env, now: number, fetchFn?: FetchFn): Promise<FxDailyResult> {
  const day = utcDay(now);
  if (await env.DB.prepare('SELECT 1 FROM fx_rates WHERE obs_day = ?').bind(day).first()) return 'exists';
  const got = await fetchEgpPerUsd(fetchFn);
  if (!got) {
    alert('fx_fetch_failed', { sources: FX_SOURCES.length });
    return 'fetch_failed';
  }
  const last = await env.DB.prepare('SELECT egp_per_usd_micros AS m FROM fx_rates ORDER BY ver DESC LIMIT 1').first<{ m: number }>();
  if (last) {
    const movePct = (got.micros / last.m - 1) * 100;
    if (Math.abs(movePct) > FX_BAND_PCT) {
      alert('fx_rate_rejected', { source: got.source, observedMicros: got.micros, lastMicros: last.m, movePct: Math.round(movePct * 100) / 100 });
      return 'rejected';
    }
  }
  const hist = await env.DB.prepare('SELECT egp_per_usd_micros AS m FROM fx_rates WHERE source IS NOT NULL AND obs_day < ? ORDER BY obs_day DESC LIMIT ?').bind(day, HISTORY_DAYS).all<{ m: number }>();
  const rates = [...hist.results.map((r) => r.m / 1e6).reverse(), got.micros / 1e6];
  const prev = await env.DB.prepare('SELECT buffer_bps AS b FROM fx_rates ORDER BY ver DESC LIMIT 1').first<{ b: number }>();
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

/** The newest rate row older than 48 h, or none at all: the price is running on a rate nobody refreshed. */
async function checkStale(env: Env, now: number): Promise<void> {
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
