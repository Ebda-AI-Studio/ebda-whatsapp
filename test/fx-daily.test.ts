import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { FX_BAND_PCT, dailyFx, fetchEgpPerUsd, getFxBufferPin, setFxBufferPin } from '../src/core/billing/fx-daily';
import { OP1, operatorCall, useApiKey } from './helpers/api';

useApiKey();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D0 = Date.UTC(2026, 10, 12, 1, 17);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { ver: number; effective_from: number; egp_per_usd_micros: number; buffer_bps: number; published_at: number; source: string | null; obs_day: string | null; buffer_mode: string | null; vol_bps: number | null };
const all = async () => (await env.DB.prepare('SELECT ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, source, obs_day, buffer_mode, vol_bps FROM fx_rates ORDER BY ver').all<Row>()).results;

/** A fetch with a REAL delay (so interleaving and timeouts are exercised, not skipped). `by` decides per URL. */
function mockFetch(by: (url: string) => Response | Promise<Response>, delayMs = 25) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    await sleep(delayMs);
    return by(url);
  }) as typeof fetch;
  return { fn, calls };
}
const fawaz = (egp: unknown) => new Response(JSON.stringify({ date: '2026-11-12', usd: { egp } }), { status: 200 });
const er = (egp: unknown) => new Response(JSON.stringify({ result: 'success', rates: { EGP: egp } }), { status: 200 });
const errLines = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

beforeEach(() => configureSessionCheck(async () => false)); // healthy accounts service, as in operator.test.ts
afterEach(() => { vi.restoreAllMocks(); configureSessionCheck(null); });

describe('fetchEgpPerUsd: parse and fall through', () => {
  it('parses the primary and converts to micros', async () => {
    const m = mockFetch(() => fawaz(53.32167151));
    expect(await fetchEgpPerUsd(m.fn)).toEqual({ source: 'fawazahmed0', micros: 53_321_672 });
    expect(m.calls).toHaveLength(1);
  });
  it('a malformed or out-of-range body is a failed source, never a rate; the next source answers', async () => {
    const m = mockFetch((u) => (u.includes('jsdelivr') ? fawaz('53.3') : u.includes('pages.dev') ? fawaz(-4) : er(53.55)));
    expect(await fetchEgpPerUsd(m.fn)).toEqual({ source: 'open.er-api', micros: 53_550_000 });
    expect(m.calls).toHaveLength(3);
  });
  it('er-api answering result:error and an HTTP 500 both count as failures; all failed gives null', async () => {
    const m = mockFetch((u) => (u.includes('er-api') ? new Response(JSON.stringify({ result: 'error' }), { status: 200 }) : new Response('boom', { status: 500 })));
    expect(await fetchEgpPerUsd(m.fn)).toBeNull();
  });
});

describe('dailyFx: append-only daily row', () => {
  it('first run inserts one row: 700 (no history), effective 24 h ahead, source and day recorded', async () => {
    const m = mockFetch(() => fawaz(53.3));
    expect(await dailyFx(env, D0, m.fn)).toBe('inserted');
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ver: 1, egp_per_usd_micros: 53_300_000, buffer_bps: 700, buffer_mode: 'short_history', source: 'fawazahmed0', obs_day: '2026-11-12', effective_from: D0 + DAY, published_at: D0 });
  });

  it('idempotent: a second run (or a retry, or a concurrent one) on the same UTC day inserts nothing and does not even fetch', async () => {
    const m = mockFetch(() => fawaz(53.9));
    expect(await dailyFx(env, D0 + 5 * HOUR, m.fn)).toBe('exists');
    expect(m.calls).toHaveLength(0);
    // Two simultaneous first-of-day runs: the unique index lets exactly one row in.
    const t = D0 + DAY;
    const a = mockFetch(() => fawaz(53.4));
    const b = mockFetch(() => fawaz(53.4));
    const res = await Promise.all([dailyFx(env, t, a.fn), dailyFx(env, t, b.fn)]);
    expect(res.filter((r) => r === 'inserted')).toHaveLength(1);
    expect((await all()).filter((r) => r.obs_day === '2026-11-13')).toHaveLength(1);
  });

  it('append-only: yesterday\'s row is byte-identical after today\'s insert, and the database refuses an UPDATE', async () => {
    const before = (await all())[0];
    await dailyFx(env, D0 + 2 * DAY, mockFetch(() => fawaz(53.5)).fn);
    expect((await all())[0]).toEqual(before);
    await expect(env.DB.prepare('UPDATE fx_rates SET egp_per_usd_micros = 1 WHERE ver = 1').run()).rejects.toThrow(/immutable/);
  });

  it(`sanity band: a move above ${FX_BAND_PCT}% is NOT inserted, the last rate stays, the observed value is in the alert`, async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = (await all()).length;
    expect(await dailyFx(env, D0 + 3 * DAY, mockFetch(() => fawaz(53.5 * 1.06)).fn)).toBe('rejected');
    expect(await all()).toHaveLength(n);
    const line = errLines().find((l) => l.includes('fx_rate_rejected'));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toMatchObject({ alert: 'fx_rate_rejected', source: 'fawazahmed0', observedMicros: 56_710_000, lastMicros: 53_500_000 });
    spy.mockRestore();
    // a 4.9% move is inside the band and recorded (with the jump rule: above 3% sets 700)
    expect(await dailyFx(env, D0 + 3 * DAY + HOUR, mockFetch(() => fawaz(53.5 * 1.049)).fn)).toBe('inserted');
    expect((await all()).at(-1)).toMatchObject({ buffer_mode: 'short_history', buffer_bps: 700 });
  });

  it('stale fallback: every source failing keeps the last rate, alerts fx_fetch_failed, and fx_rate_stale fires only past 48 h', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = (await all()).length;
    const newest = (await all()).at(-1)!.published_at;
    const dead = mockFetch(() => new Response('down', { status: 503 }));
    expect(await dailyFx(env, newest + 47 * HOUR, dead.fn)).toBe('fetch_failed');
    expect(errLines().some((l) => l.includes('fx_fetch_failed'))).toBe(true);
    expect(errLines().some((l) => l.includes('fx_rate_stale'))).toBe(false);
    expect(await dailyFx(env, newest + 49 * HOUR, dead.fn)).toBe('fetch_failed');
    expect(errLines().some((l) => l.includes('fx_rate_stale'))).toBe(true);
    expect(await all()).toHaveLength(n); // never an insert on failure
    spy.mockRestore();
  });

  it('falls back to open.er-api when the primary hosts fail, and records the source', async () => {
    const newest = (await all()).at(-1)!;
    const m = mockFetch((u) => (u.includes('er-api') ? er(newest.egp_per_usd_micros / 1e6) : new Response('x', { status: 502 })));
    expect(await dailyFx(env, D0 + 10 * DAY, m.fn)).toBe('inserted');
    expect((await all()).at(-1)!.source).toBe('open.er-api');
    expect(m.calls.filter((u) => u.includes('er-api'))).toHaveLength(1);
  });
});

describe('operator pin', () => {
  it('a pinned buffer replaces the computed one on the next row (inputs still recorded), and null unpins', async () => {
    const last = (await all()).at(-1)!.egp_per_usd_micros / 1e6;
    await setFxBufferPin(env, { actor: OP1, bufferBps: 650, reason: 'devaluation expected' });
    expect(await getFxBufferPin(env)).toMatchObject({ bufferBps: 650, actor: OP1 });
    await dailyFx(env, D0 + 11 * DAY, mockFetch(() => fawaz(last)).fn);
    expect((await all()).at(-1)).toMatchObject({ buffer_bps: 650, buffer_mode: 'pinned' });
    await setFxBufferPin(env, { actor: OP1, bufferBps: null, reason: 'back to computed' });
    await dailyFx(env, D0 + 12 * DAY, mockFetch(() => fawaz(last)).fn);
    expect((await all()).at(-1)!.buffer_mode).toBe('short_history');
    await expect(env.DB.prepare('DELETE FROM fx_buffer_pins').run()).rejects.toThrow(/immutable/);
  });

  it('the operator route needs a reason and validates the range; the GET reflects the pin', async () => {
    expect((await operatorCall(OP1, 'PUT', '/fx-buffer-pin', { bufferBps: 600 })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', '/fx-buffer-pin', { bufferBps: 99999, reason: 'too high pin' })).status).toBe(400);
    expect((await operatorCall(OP1, 'PUT', '/fx-buffer-pin', { bufferBps: 600, reason: 'hold it steady' })).status).toBe(200);
    expect(await (await operatorCall(OP1, 'GET', '/fx-buffer-pin')).json()).toMatchObject({ bufferBps: 600, actor: OP1 });
    expect((await operatorCall(null, 'PUT', '/fx-buffer-pin', { bufferBps: 1, reason: 'no token here' })).status).toBe(401);
    const fx = (await (await operatorCall(OP1, 'GET', '/fx-rates')).json()) as { items: Record<string, unknown>[] };
    expect(fx.items[0]).toMatchObject({ source: expect.any(String), bufferMode: expect.any(String) });
  });
});
