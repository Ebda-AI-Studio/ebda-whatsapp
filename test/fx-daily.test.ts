import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureSessionCheck } from '../src/core/identity/session';
import { FX_BAND_PCT, checkFxStale, dailyFx, fetchEgpPerUsd, getFxBufferPin, setFxBufferPin } from '../src/core/billing/fx-daily';
import worker, { dailyBilling } from '../src/index';
import { createExecutionContext } from 'cloudflare:test';
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
/** The feeds are stamped with the cron's clock, as a live feed is (a payload older than yesterday is a frozen feed and is refused). */
let clock = D0;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const fawaz = (egp: unknown, at = clock) => new Response(JSON.stringify({ date: dayOf(at), usd: { egp } }), { status: 200 });
const er = (egp: unknown, at = clock) => new Response(JSON.stringify({ result: 'success', time_last_update_unix: Math.floor(at / 1000), rates: { EGP: egp } }), { status: 200 });
const daily = (now: number, fn?: typeof fetch) => { clock = now; return dailyFx(env, now, fn); };
const errLines = () => (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));

beforeEach(() => configureSessionCheck(async () => false)); // healthy accounts service, as in operator.test.ts
afterEach(() => { vi.restoreAllMocks(); configureSessionCheck(null); });

describe('fetchEgpPerUsd: parse and fall through', () => {
  it('parses the primary and converts to micros', async () => {
    const m = mockFetch(() => fawaz(53.32167151));
    expect(await fetchEgpPerUsd(m.fn, D0)).toMatchObject({ source: 'fawazahmed0', provider: 'fawaz', micros: 53_321_672, day: '2026-11-12' });
    expect(m.calls).toHaveLength(1);
  });
  it('a malformed or out-of-range body is a failed source, never a rate; the next source answers', async () => {
    const m = mockFetch((u) => (u.includes('jsdelivr') ? fawaz('53.3') : u.includes('pages.dev') ? fawaz(-4) : er(53.55)));
    expect(await fetchEgpPerUsd(m.fn, D0)).toMatchObject({ source: 'open.er-api', micros: 53_550_000 });
    expect(m.calls).toHaveLength(3);
  });
  it('er-api answering result:error and an HTTP 500 both count as failures; all failed gives null', async () => {
    const m = mockFetch((u) => (u.includes('er-api') ? new Response(JSON.stringify({ result: 'error' }), { status: 200 }) : new Response('boom', { status: 500 })));
    expect(await fetchEgpPerUsd(m.fn, D0)).toBeNull();
  });
});

describe('dailyFx: append-only daily row', () => {
  it('first run inserts one row: 700 (no history), effective 24 h ahead, source and day recorded', async () => {
    const m = mockFetch(() => fawaz(53.3));
    expect(await daily(D0, m.fn)).toBe('inserted');
    const rows = await all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ver: 1, egp_per_usd_micros: 53_300_000, buffer_bps: 700, buffer_mode: 'short_history', source: 'fawazahmed0', obs_day: '2026-11-12', effective_from: D0 + DAY, published_at: D0 });
  });

  it('idempotent: a second run (or a retry, or a concurrent one) on the same UTC day inserts nothing and does not even fetch', async () => {
    const m = mockFetch(() => fawaz(53.9));
    expect(await daily(D0 + 5 * HOUR, m.fn)).toBe('exists');
    expect(m.calls).toHaveLength(0);
    // Two simultaneous first-of-day runs: the unique index lets exactly one row in.
    const t = D0 + DAY;
    const a = mockFetch(() => fawaz(53.4));
    const b = mockFetch(() => fawaz(53.4));
    const res = await Promise.all([daily(t, a.fn), daily(t, b.fn)]);
    expect(res.filter((r) => r === 'inserted')).toHaveLength(1);
    expect((await all()).filter((r) => r.obs_day === '2026-11-13')).toHaveLength(1);
  });

  it('append-only: yesterday\'s row is byte-identical after today\'s insert, and the database refuses an UPDATE', async () => {
    const before = (await all())[0];
    await daily(D0 + 2 * DAY, mockFetch(() => fawaz(53.5)).fn);
    expect((await all())[0]).toEqual(before);
    await expect(env.DB.prepare('UPDATE fx_rates SET egp_per_usd_micros = 1 WHERE ver = 1').run()).rejects.toThrow(/immutable/);
  });

  it(`sanity band: a move above ${FX_BAND_PCT}% is NOT inserted, the last rate stays, the observed value is in the alert`, async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = (await all()).length;
    expect(await daily(D0 + 3 * DAY, mockFetch(() => fawaz(53.5 * 1.06)).fn)).toBe('rejected');
    expect(await all()).toHaveLength(n);
    const line = errLines().find((l) => l.includes('fx_rate_rejected'));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toMatchObject({ alert: 'fx_rate_rejected', source: 'fawazahmed0', observedMicros: 56_710_000, lastMicros: 53_500_000 });
    spy.mockRestore();
    // a 4.9% move is inside the band and recorded (with the jump rule: above 3% sets 700)
    expect(await daily(D0 + 3 * DAY + HOUR, mockFetch(() => fawaz(53.5 * 1.049)).fn)).toBe('inserted');
    expect((await all()).at(-1)).toMatchObject({ buffer_mode: 'short_history', buffer_bps: 700 });
  });

  it('stale fallback: every source failing keeps the last rate and alerts fx_fetch_failed; never an insert on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = (await all()).length;
    const newest = (await all()).at(-1)!.published_at;
    const dead = mockFetch(() => new Response('down', { status: 503 }));
    expect(await daily(newest + 47 * HOUR, dead.fn)).toBe('fetch_failed');
    expect(errLines().some((l) => l.includes('fx_fetch_failed'))).toBe(true);
    expect(await all()).toHaveLength(n);
    spy.mockRestore();
  });

  it('staleness alarm: keyed on the observation day (obs_day), fires past 48 h, and is independent of the fetch job', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const obs = (await all()).at(-1)!.obs_day!;
    const t0 = Date.parse(`${obs}T00:00:00Z`);
    await checkFxStale(env, t0 + 47 * HOUR);
    expect(errLines().some((l) => l.includes('fx_rate_stale'))).toBe(false);
    await checkFxStale(env, t0 + 49 * HOUR);
    const line = errLines().find((l) => l.includes('fx_rate_stale'));
    expect(JSON.parse(line!)).toMatchObject({ newestObsDay: obs });
    spy.mockRestore();
  });

  it('dailyBilling runs the staleness check on its own: with the network dead and the rows old it still alarms, and it makes no FX request', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const net = vi.fn(async (_u: unknown) => { await sleep(10); throw new Error('network down'); });
    vi.stubGlobal('fetch', net);
    const obs = (await all()).at(-1)!.obs_day!;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(`${obs}T00:00:00Z`) + 49 * HOUR);
    try {
      await dailyBilling(env);
      expect(errLines().some((l) => l.includes('fx_rate_stale'))).toBe(true);
      expect(net.mock.calls.filter(([u]) => /currency-api|er-api/.test(String(u)))).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      spy.mockRestore();
    }
  });

  it('a FROZEN feed is a failed source: a payload dated before yesterday falls through to the next source (fawaz date and er-api time_last_update_unix)', async () => {
    const last = (await all()).at(-1)!.egp_per_usd_micros / 1e6;
    const t = D0 + 5 * DAY;
    const frozen = mockFetch((u) => (u.includes('er-api') ? er(last, t) : fawaz(last, t - 3 * DAY)));
    expect(await daily(t, frozen.fn)).toBe('inserted');
    expect((await all()).at(-1)!.source).toBe('open.er-api'); // both fawaz hosts were refused as stale
    expect(frozen.calls).toHaveLength(3);
    // yesterday's date is still fresh (a feed that updates after our cron); the cron day itself is stored as obs_day
    const t2 = D0 + 6 * DAY;
    expect(await daily(t2, mockFetch(() => fawaz(last, t2 - DAY)).fn)).toBe('inserted');
    // every source frozen: nothing is inserted, the last rate stays
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const n = (await all()).length;
    const t3 = D0 + 7 * DAY;
    expect(await daily(t3, mockFetch((u) => (u.includes('er-api') ? er(last, t3 - 3 * DAY) : fawaz(last, t3 - 2 * DAY))).fn)).toBe('fetch_failed');
    expect(await all()).toHaveLength(n);
    expect(errLines().some((l) => l.includes('fx_fetch_failed'))).toBe(true);
    spy.mockRestore();
  });

  it('a real devaluation is auto-accepted when the OTHER provider agrees within 1% and is fresh: inserted, with a P1 "accepted large move" alert carrying both values', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const last = (await all()).at(-1)!.egp_per_usd_micros / 1e6;
    const t = D0 + 8 * DAY;
    const m = mockFetch((u) => (u.includes('er-api') ? er(last * 1.081, t) : fawaz(last * 1.08, t)));
    expect(await daily(t, m.fn)).toBe('inserted');
    const row = (await all()).at(-1)!;
    expect(row).toMatchObject({ source: 'fawazahmed0', egp_per_usd_micros: Math.round(last * 1.08 * 1e6) });
    const line = errLines().find((l) => l.includes('fx_large_move_accepted'));
    expect(JSON.parse(line!)).toMatchObject({ alert: 'fx_large_move_accepted', source: 'fawazahmed0', otherSource: 'open.er-api', observedMicros: row.egp_per_usd_micros, otherMicros: Math.round(last * 1.081 * 1e6) });
    expect(errLines().some((l) => l.includes('fx_rate_rejected'))).toBe(false);
    spy.mockRestore();
  });

  it('disagreeing, missing or stale second sources keep the move REJECTED, and the alert shows what the other source said', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const last = (await all()).at(-1)!.egp_per_usd_micros / 1e6;
    const n = (await all()).length;
    const t = D0 + 9 * DAY;
    expect(await daily(t, mockFetch((u) => (u.includes('er-api') ? er(last * 1.06, t) : fawaz(last * 1.08, t))).fn)).toBe('rejected'); // 1.9% apart
    expect(JSON.parse(errLines().find((l) => l.includes('fx_rate_rejected'))!)).toMatchObject({ otherSource: 'open.er-api', otherMicros: Math.round(last * 1.06 * 1e6) });
    expect(await daily(t, mockFetch((u) => (u.includes('er-api') ? er(last * 1.08, t - 3 * DAY) : fawaz(last * 1.08, t))).fn)).toBe('rejected'); // agrees but is frozen
    expect(await daily(t, mockFetch((u) => (u.includes('er-api') ? new Response('down', { status: 503 }) : fawaz(last * 1.08, t))).fn)).toBe('rejected'); // missing
    expect(await all()).toHaveLength(n);
    expect(errLines().some((l) => l.includes('fx_large_move_accepted'))).toBe(false);
    spy.mockRestore();
  });

  it('falls back to open.er-api when the primary hosts fail, and records the source', async () => {
    const newest = (await all()).at(-1)!;
    const m = mockFetch((u) => (u.includes('er-api') ? er(newest.egp_per_usd_micros / 1e6) : new Response('x', { status: 502 })));
    expect(await daily(D0 + 10 * DAY, m.fn)).toBe('inserted');
    expect((await all()).at(-1)!.source).toBe('open.er-api');
    expect(m.calls.filter((u) => u.includes('er-api'))).toHaveLength(1);
  });
});

describe('operator pin', () => {
  it('a pinned buffer replaces the computed one on the next row (inputs still recorded), and null unpins', async () => {
    const last = (await all()).at(-1)!.egp_per_usd_micros / 1e6;
    await setFxBufferPin(env, { actor: OP1, bufferBps: 650, reason: 'devaluation expected' });
    expect(await getFxBufferPin(env)).toMatchObject({ bufferBps: 650, actor: OP1 });
    await daily(D0 + 11 * DAY, mockFetch(() => fawaz(last)).fn);
    expect((await all()).at(-1)).toMatchObject({ buffer_bps: 650, buffer_mode: 'pinned' });
    await setFxBufferPin(env, { actor: OP1, bufferBps: null, reason: 'back to computed' });
    await daily(D0 + 12 * DAY, mockFetch(() => fawaz(last)).fn);
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

  it('fx-rates: bufferBps is REQUIRED on a hand publish (no silent 0), and the list is ordered by effective date, not insertion order', async () => {
    const eff = Date.now() + 30 * HOUR;
    expect((await operatorCall(OP1, 'POST', '/fx-rates', { effectiveFrom: eff, egpPerUsdMicros: 50_000_000, reason: 'no buffer given' })).status).toBe(400);
    expect((await operatorCall(OP1, 'POST', '/fx-rates', { effectiveFrom: eff, egpPerUsdMicros: 50_000_000, bufferBps: 600, reason: 'explicit buffer' })).status).toBe(201);
    // a later-inserted row with an OLD effective date must not sort first
    await env.DB.prepare("INSERT INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor) VALUES ((SELECT max(ver) + 1 FROM fx_rates), 1, 40000000, 0, 0, 'test')").run();
    const items = ((await (await operatorCall(OP1, 'GET', '/fx-rates')).json()) as { items: { effectiveFrom: number }[] }).items;
    expect(items[0]!.effectiveFrom).not.toBe(1);
    expect(items.at(-1)!.effectiveFrom).toBe(1);
    expect(items.map((i) => i.effectiveFrom)).toEqual([...items.map((i) => i.effectiveFrom)].sort((a, b) => b - a));
  });
});

describe('/health fx fields', () => {
  const health = async (over: Record<string, unknown> = {}) => {
    const res = await (worker as unknown as ExportedHandler<typeof env>).fetch!(new Request('https://x/health'), { ...env, ...over } as typeof env, createExecutionContext());
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  it('reports the newest observed rate day and its age as plain fields, always 200', async () => {
    const newest = (await env.DB.prepare('SELECT max(obs_day) AS d FROM fx_rates').first<{ d: string }>())!.d;
    const r = await health();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, fxObsDay: newest });
    expect(typeof r.body.fxAgeHours).toBe('number');
  });
  it('a failing read never fails the probe: both fields become null', async () => {
    const r = await health({ DB: { prepare: () => { throw new Error('d1 down'); } } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, fxObsDay: null, fxAgeHours: null });
  });
});
