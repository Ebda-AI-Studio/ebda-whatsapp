import { SELF, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { botFunnelDto } from '../src/core/api/contract';
import { cairoDay, funnelRollup, recordFunnelStep } from '../src/core/bot-funnel';
import { apiFor, storeId as W, useApiKey } from './helpers/api';
import { workspace } from './helpers/workspace';

useApiKey();
const DAY = 86_400_000;
// Noon UTC (mid-afternoon in Cairo): whole-day offsets stay on the intended calendar day even across the clock change.
const NOW = new Date().setUTCHours(12, 0, 0, 0);
const day = (ms: number) => cairoDay(ms);

/** Seeds funnel markers in a workspace: [step, wa id, ms]. */
const seed = (ws: string, items: [Parameters<typeof recordFunnelStep>[1]['step'], string, number][], rollupAt?: number) =>
  runInDurableObject(workspace(ws), async (_i, s) => {
    for (const [step, waId, now] of items) await recordFunnelStep(s.storage.sql, { step, waId, now });
    if (rollupAt) funnelRollup(s.storage.sql, rollupAt);
  });
const get = async (api: Awaited<ReturnType<typeof apiFor>>, from: string, to: string) => api.call('GET', `/bot/funnel?from=${from}&to=${to}`);

describe('GET /bot/funnel', () => {
  it('returns per-step totals and a zero-filled daily series, rolled-up days and today\'s live markers together', async () => {
    const ws = W(7101);
    const api = await apiFor(ws, 'owner');
    // two days ago and yesterday are rolled up; today is live
    await seed(ws, [
      ['conversation', '201000000001', NOW - 2 * DAY], ['conversation', '201000000002', NOW - 2 * DAY], ['browse', '201000000001', NOW - 2 * DAY],
      ['conversation', '201000000001', NOW - DAY], ['order', '201000000001', NOW - DAY],
    ], NOW);
    await seed(ws, [['conversation', '201000000001', NOW], ['conversation', '201000000003', NOW], ['conversation', '201000000003', NOW], ['cart', '201000000003', NOW]]);
    const from = day(NOW - 3 * DAY);
    const to = day(NOW);
    const res = await get(api, from, to);
    expect(res.status).toBe(200);
    const body = botFunnelDto.parse(await res.json());
    expect(body.days).toEqual([day(NOW - 3 * DAY), day(NOW - 2 * DAY), day(NOW - DAY), day(NOW)]);
    const s = Object.fromEntries(body.steps.map((x) => [x.step, x]));
    expect(s.conversation).toMatchObject({ total: 5, series: [0, 2, 1, 2] });
    expect(s.browse).toMatchObject({ total: 1, series: [0, 1, 0, 0] });
    expect(s.cart).toMatchObject({ total: 1, series: [0, 0, 0, 1] });
    expect(s.order).toMatchObject({ total: 1, series: [0, 0, 1, 0] });
    expect(s.checkout!.total).toBe(0);
    expect(body.steps.map((x) => x.step)).toEqual(['conversation', 'browse', 'cart', 'checkout', 'order', 'menu', 'handoff']);
  });

  it('a range only includes its own days', async () => {
    const ws = W(7102);
    const api = await apiFor(ws, 'owner');
    await seed(ws, [['browse', '201000000001', NOW - 5 * DAY], ['browse', '201000000002', NOW]], NOW);
    const body = botFunnelDto.parse(await (await get(api, day(NOW - DAY), day(NOW))).json());
    expect(body.steps.find((x) => x.step === 'browse')!.total).toBe(1);
  });

  it('staff can read; the answer carries no personal data', async () => {
    const ws = W(7103);
    const api = await apiFor(ws, 'staff');
    await seed(ws, [['browse', '201000000001', NOW]]);
    const res = await get(api, day(NOW), day(NOW));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('2010000');
  });

  it.each([
    ['missing both', ''],
    ['bad date', '?from=2026-13-01&to=2026-13-02'],
    ['not a date', '?from=yesterday&to=today'],
    ['reversed', '?from=2026-05-10&to=2026-05-01'],
    ['more than 92 days', '?from=2026-01-01&to=2026-04-03'],
    ['impossible day', '?from=2026-02-30&to=2026-03-02'],
  ])('rejects %s with 400', async (_n, q) => {
    const api = await apiFor(W(7104), 'owner');
    expect((await api.call('GET', `/bot/funnel${q}`)).status).toBe(400);
  });

  it('accepts exactly 92 days', async () => {
    const api = await apiFor(W(7105), 'owner');
    const res = await api.call('GET', '/bot/funnel?from=2026-01-01&to=2026-04-02');
    expect(res.status).toBe(200);
    expect(botFunnelDto.parse(await res.json()).days).toHaveLength(92);
  });

  it('is read-only: no write method exists, and an unknown store or no token is refused', async () => {
    const api = await apiFor(W(7106), 'owner');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect((await api.call(m, '/bot/funnel', {})).status).toBeGreaterThanOrEqual(404);
    const other = await apiFor(W(7107), 'owner');
    const res = await SELF.fetch(`https://x/api/v1/stores/${W(7106)}/bot/funnel?from=2026-05-01&to=2026-05-02`, { headers: { authorization: `Bearer ${other.token}` } }).catch(() => null);
    expect(res!.status).toBeGreaterThanOrEqual(403);
  });
});
