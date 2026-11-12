import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { pullPricing, copyCursor } from '../src/core/billing/pricing';
import { backfillFx, dailyFx } from '../src/core/billing/fx-daily';
import { computeFxBuffer } from '../src/core/billing/fx-buffer';
import { OP1, operatorCall, useApiKey } from './helpers/api';
import fixture from './fixtures/egp-usd-364d.json';

useApiKey();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOW = Date.UTC(2026, 10, 13, 1, 17); // fixture covers 2025-11-12 .. 2026-11-12
const byDay = new Map((fixture as { days: string[]; egp: number[] }).days.map((d, i) => [d, (fixture as { egp: number[] }).egp[i]!]));

type Row = { ver: number; egp_per_usd_micros: number; buffer_bps: number; source: string; obs_day: string; buffer_mode: string; effective_from: number; actor: string };
const rowsOf = async () => (await env.DB.prepare('SELECT ver, egp_per_usd_micros, buffer_bps, source, obs_day, buffer_mode, effective_from, actor FROM fx_rates ORDER BY obs_day').all<Row>()).results;

/** Serves the dated snapshots from the real series, with a real delay; `gaps` days answer 404, `wrongDate` answers another day's date. */
function dated(o: { gaps?: string[]; wrongDate?: string[]; delay?: number } = {}) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    await sleep(o.delay ?? 5);
    const day = /@(\d{4}-\d{2}-\d{2})\//.exec(url)?.[1];
    const v = day ? byDay.get(day) : undefined;
    if (!day || v === undefined || o.gaps?.includes(day)) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify({ date: o.wrongDate?.includes(day) ? '2000-01-01' : day, usd: { egp: v } }), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

beforeEach(() => configureSessionCheck(async () => false));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); configureSessionCheck(null); });

describe('fx backfill', () => {
  it('loads the window as source=backfill; only the NEWEST row carries a computed buffer, the rest are 700 inputs', async () => {
    const m = dated();
    const r = await backfillFx(env, { days: 90, actor: OP1, reason: 'seed history' }, NOW, m.fn);
    expect(r).toMatchObject({ requested: 90, newestDay: '2026-11-12', existing: 0 });
    const rows = await rowsOf();
    expect(rows).toHaveLength(r.inserted);
    expect(r.inserted).toBeGreaterThan(80); // 90 days minus the few the real series lacks
    expect(rows.every((x) => x.source === 'backfill' && x.actor === 'system:fx-backfill')).toBe(true);
    expect(rows.slice(0, -1).every((x) => x.buffer_bps === 700 && x.buffer_mode === 'backfill')).toBe(true);
    const newest = rows.at(-1)!;
    expect(newest.buffer_mode).toBe('computed');
    // Equals the pure function over the same days with no previous buffer (no fall limit on day 1); 90 days is enough for 60 vol windows.
    const series = rows.map((x) => ({ day: x.obs_day, rate: x.egp_per_usd_micros / 1e6 }));
    expect(newest.buffer_bps).toBe(computeFxBuffer(series, null).bufferBps);
    expect(newest.effective_from).toBe(Date.UTC(2026, 10, 12));
    expect(r.newestBufferBps).toBe(newest.buffer_bps);
  });

  it('idempotent: a re-run inserts nothing, fetches nothing, and leaves every row byte-identical', async () => {
    const before = await rowsOf();
    const m = dated();
    const r = await backfillFx(env, { days: 90, actor: OP1, reason: 'seed history' }, NOW, m.fn);
    expect(r).toMatchObject({ inserted: 0, fetched: 0, existing: before.length });
    expect(m.calls).toHaveLength(r.missing); // only the days the real series lacks are asked again; nothing already stored is
    expect(await rowsOf()).toEqual(before);
  });

  it('a wider window adds only the missing older days; a day that is absent, or dated differently, is a counted gap, never a row', async () => {
    const m = dated({ gaps: ['2026-07-10'], wrongDate: ['2026-07-11'] });
    const have = (await rowsOf()).length;
    const r = await backfillFx(env, { days: 150, actor: OP1, reason: 'seed more history' }, NOW, m.fn);
    const wanted = Array.from({ length: 150 }, (_, i) => new Date(Date.UTC(2026, 10, 13) - (150 - i) * 86_400_000).toISOString().slice(0, 10));
    const withData = wanted.filter((d) => byDay.has(d) && d !== '2026-07-10' && d !== '2026-07-11');
    expect(r.inserted).toBe(withData.length - have);
    expect(r).toMatchObject({ requested: 150, existing: have, missing: 150 - have - r.inserted }); // the two injected gaps are among the missing
    expect((await rowsOf()).length).toBe(withData.length);
    const days = (await rowsOf()).map((x) => x.obs_day);
    expect(days).not.toContain('2026-07-10');
    expect(days).not.toContain('2026-07-11');
    // the newest row on file did not change: older days are inputs only
    expect((await rowsOf()).at(-1)!.buffer_mode).toBe('computed');
  });

  it('backfilled rows are history, never prices: the workspace pricing pull does not receive a single one', async () => {
    const snap = await pullPricing(env, '00000000-0000-4000-8000-000000007601', { rates: 0, fx: 0, settings: 0, overrides: 0 });
    expect(snap.fx).toEqual([]);
    expect((await rowsOf()).length).toBeGreaterThan(100);
    // a cron row IS priceable and is the only one the pull returns
    const last = (await rowsOf()).at(-1)!.egp_per_usd_micros / 1e6;
    const fn = (async () => new Response(JSON.stringify({ date: '2026-11-13', usd: { egp: last } }), { status: 200 })) as typeof fetch;
    expect(await dailyFx(env, NOW, fn)).toBe('inserted');
    const after = await pullPricing(env, '00000000-0000-4000-8000-000000007601', { rates: 0, fx: 0, settings: 0, overrides: 0 });
    expect(after.fx).toHaveLength(1);
    expect(after.fx[0]!.ver).toBeGreaterThan(100);
  });

  it('the daily cron then continues from the history: today gets a computed buffer (not 700) and keeps the 50 bps fall limit', async () => {
    const last = (await rowsOf()).filter((x) => x.obs_day < '2026-11-13').at(-1)!;
    const m = { calls: 0 };
    const fn = (async () => { m.calls++; await sleep(5); return new Response(JSON.stringify({ date: '2026-11-13', usd: { egp: last.egp_per_usd_micros / 1e6 } }), { status: 200 }); }) as typeof fetch;
    expect(await dailyFx(env, NOW, fn)).toBe('exists'); // already inserted by the pricing test above (one row per day)
    const today = (await rowsOf()).find((x) => x.obs_day === '2026-11-13')!;
    expect(today.buffer_mode).toBe('computed');
    expect(today.buffer_bps).toBeGreaterThanOrEqual(last.buffer_bps - 50);
    expect(today.source).toBe('fawazahmed0');
  });
});

describe('fx backfill: a full year through the route', () => {
  it('the route needs a reason and a token, returns the counts, and is idempotent', async () => {
    const real = globalThis.fetch;
    const feed = dated().fn;
    vi.stubGlobal('fetch', ((i: RequestInfo | URL, init?: RequestInit) => (String(i).includes('currency-api') ? feed(i, init) : real(i, init))) as typeof fetch); // only the FX feed is faked
    expect((await operatorCall(null, 'POST', '/fx-backfill', { reason: 'no token here' })).status).toBe(401);
    expect((await operatorCall(OP1, 'POST', '/fx-backfill', { days: 365 })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', '/fx-backfill', { days: 9999, reason: 'way too many' })).status).toBe(400);
    const r = await operatorCall(OP1, 'POST', '/fx-backfill', { days: 365, reason: 'seed a full year' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { requested: number; inserted: number; existing: number };
    expect(body.requested).toBe(365);
    expect(body.inserted + body.existing).toBeGreaterThan(100); // the earlier tests already seeded part of the window; the real series itself lacks a few days
    const again = (await (await operatorCall(OP1, 'POST', '/fx-backfill', { days: 365, reason: 'second run is a no-op' })).json()) as { inserted: number };
    expect(again.inserted).toBe(0);
  });
});
