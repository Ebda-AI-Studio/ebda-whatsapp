import { SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOpen, nextOpenAt } from '../src/core/front-desk-hours';
import type { HoursSettings } from '../src/core/store-link/bot-settings';
import { holdPoint } from './helpers/hold';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { apiFor, storeId, useApiKey } from './helpers/api';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { rawMessagePayload } from './helpers/payload';
import { WA_1, storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

const link = useStoreLink();
useApiKey();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000062${String(n).padStart(2, '0')}`;

const AWAY = { ar: 'احنا مقفولين دلوقتي، هنرد عليك أول ما نفتح.', en: 'We are closed right now; we will reply as soon as we open.' };
/** Sunday = 0 ... Saturday = 6 (the weekday numbers of JavaScript's Date). */
const week = (over: Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, { open: string; close: string }[]>> = {}): HoursSettings['week'] => ({
  0: [{ open: '10:00', close: '18:00' }], 1: [{ open: '10:00', close: '18:00' }], 2: [{ open: '10:00', close: '18:00' }], 3: [{ open: '10:00', close: '18:00' }],
  4: [{ open: '10:00', close: '18:00' }], 5: [], 6: [{ open: '10:00', close: '18:00' }], ...over,
});
const hours = (over: Partial<HoursSettings> = {}): HoursSettings => ({ enabled: true, timezone: 'Africa/Cairo', week: week(), awayMessage: AWAY, ordersWhileClosed: true, ...over });
const at = (iso: string) => Date.parse(iso);

describe('isOpen / nextOpenAt (Africa/Cairo)', () => {
  // 2026-10-29 is a Thursday. Cairo is UTC+3 until the clocks go back at the end of that day, UTC+2 after.
  it('opens at the opening minute and closes at the closing minute (end exclusive)', () => {
    const h = hours();
    expect(isOpen(h, at('2026-10-29T06:59:00Z'))).toBe(false); // 09:59
    expect(isOpen(h, at('2026-10-29T07:00:00Z'))).toBe(true); // 10:00
    expect(isOpen(h, at('2026-10-29T14:59:00Z'))).toBe(true); // 17:59
    expect(isOpen(h, at('2026-10-29T15:00:00Z'))).toBe(false); // 18:00
  });

  it('a day with no ranges is closed all day, and disabled hours are always open', () => {
    expect(isOpen(hours(), at('2026-10-30T09:00:00Z'))).toBe(false); // Friday
    expect(isOpen(hours({ enabled: false }), at('2026-10-30T09:00:00Z'))).toBe(true);
  });

  it('an overnight range stays open past midnight and belongs to the day it opened', () => {
    const h = hours({ week: week({ 4: [{ open: '22:00', close: '02:00' }], 5: [] }) });
    expect(isOpen(h, at('2026-10-29T18:30:00Z'))).toBe(false); // Thu 21:30 local
    expect(isOpen(h, at('2026-10-29T19:30:00Z'))).toBe(true); // Thu 22:30
    expect(isOpen(h, at('2026-10-29T22:30:00Z'))).toBe(true); // Fri 00:30 local (after the clocks went back)
    expect(isOpen(h, at('2026-10-29T23:59:00Z'))).toBe(true); // Fri 01:59 local
    expect(isOpen(h, at('2026-10-30T00:00:00Z'))).toBe(false); // Fri 02:00 local, the closing minute
  });

  it('two ranges in a day', () => {
    const h = hours({ week: week({ 0: [{ open: '09:00', close: '12:00' }, { open: '16:00', close: '20:00' }] }) });
    expect(isOpen(h, at('2026-11-01T08:00:00Z'))).toBe(true); // Sun 10:00 local (UTC+2)
    expect(isOpen(h, at('2026-11-01T12:00:00Z'))).toBe(false); // 14:00
    expect(isOpen(h, at('2026-11-01T15:00:00Z'))).toBe(true); // 17:00
  });

  it('DST end: the repeated 23:30 hour of 2026-10-29 is open both times, and the offset change moves the next opening', () => {
    const h = hours({ week: week({ 4: [{ open: '22:00', close: '23:45' }], 5: [{ open: '09:00', close: '10:00' }] }) });
    expect(isOpen(h, at('2026-10-29T20:30:00Z'))).toBe(true); // 23:30 (UTC+3)
    expect(isOpen(h, at('2026-10-29T21:30:00Z'))).toBe(true); // 23:30 again (UTC+2)
    expect(isOpen(h, at('2026-10-29T22:30:00Z'))).toBe(false); // Fri 00:30
    // Friday 09:00 local after the change is 07:00Z, not 06:00Z
    expect(nextOpenAt(h, at('2026-10-29T22:30:00Z'))).toBe(at('2026-10-30T07:00:00Z'));
  });

  it('DST start: Friday 2026-04-24 is UTC+3 from 01:00, so a 09:00 opening is 06:00Z; the day before it was 07:00Z', () => {
    const h = hours({ week: week({ 4: [{ open: '09:00', close: '10:00' }], 5: [{ open: '09:00', close: '10:00' }] }) });
    expect(isOpen(h, at('2026-04-23T07:00:00Z'))).toBe(true); // Thu 09:00 (UTC+2)
    expect(isOpen(h, at('2026-04-24T06:00:00Z'))).toBe(true); // Fri 09:00 (UTC+3)
    expect(isOpen(h, at('2026-04-24T05:59:00Z'))).toBe(false);
    expect(nextOpenAt(h, at('2026-04-23T12:00:00Z'))).toBe(at('2026-04-24T06:00:00Z'));
  });

  it('nextOpenAt is stable across a closed period (the away-once key) and null when never open', () => {
    const h = hours();
    const a = nextOpenAt(h, at('2026-10-29T15:00:00Z'));
    expect(a).toBe(at('2026-10-31T08:00:00Z')); // Fri closed -> Sat 10:00 local (UTC+2)
    expect(nextOpenAt(h, at('2026-10-30T20:00:00Z'))).toBe(a);
    expect(nextOpenAt(hours({ week: week({ 0: [], 1: [], 2: [], 3: [], 4: [], 6: [] }) }), at('2026-10-29T15:00:00Z'))).toBeNull();
  });
});

type Sent = { kind: string; body: Record<string, any> };
const sentOf = (g: ReturnType<typeof stubGraph>, pn: string, from = 0): Sent[] => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/${pn}/messages`)).slice(from).map((c) => {
  const b = c.body as Record<string, any>;
  return { kind: b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type, body: b };
});
let seq = 0;
async function say(ws: string, pn: string, t: string, g: ReturnType<typeof stubGraph>, now: number) {
  const from = sentOf(g, pn).length;
  const msg = { id: `wamid.hours.${++seq}.${Date.now()}`, from: WA_1, type: 'text', text: { body: t }, timestamp: String(Math.floor(now / 1000)) }; // the message carries the fixed time, so the 24 h window is open at it
  expect((await postWebhook(SELF, rawMessagePayload(pn, msg))).status).toBe(200);
  await workspace(ws).runDueTasks(now);
  return sentOf(g, pn, from);
}
async function setup(n: number, h: HoursSettings | null, extra: Record<string, unknown> = {}) {
  const ws = W(n);
  const pn = await storeWorkspace(ws);
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  if (h) expect((await workspace(ws).setStoreLinkSettings({ hours: h, ...extra } as never)).ok).toBe(true);
  return { ws, pn };
}
// Thursday 2026-10-29 20:00 Cairo (closed), and Saturday 2026-10-31 12:00 Cairo (open), Saturday 20:00 (closed again)
const CLOSED_THU = at('2026-10-29T17:00:00Z');
const OPEN_SAT = at('2026-10-31T10:00:00Z');
const CLOSED_SAT = at('2026-10-31T18:00:00Z');

describe('out-of-hours auto reply', () => {
  it('the first inbound of a closed period gets the away message ONCE, then the ordering bot carries on', async () => {
    const { ws, pn } = await setup(1, hours());
    const g = stubGraph();
    const first = await say(ws, pn, 'hi', g, CLOSED_THU);
    expect(first[0]!.body.text.body).toBe(AWAY.en); // Latin text -> English
    expect(first.length).toBeGreaterThan(1); // the bot answered too (orders while closed)
    const second = await say(ws, pn, 'hi', g, CLOSED_THU + 60_000);
    expect(second.some((s) => s.body.text?.body === AWAY.en)).toBe(false);
    expect(second.length).toBeGreaterThan(0);
    // open -> nothing; the next closed period gets it again
    expect((await say(ws, pn, 'hi', g, OPEN_SAT)).some((s) => s.body.text?.body === AWAY.en)).toBe(false);
    expect((await say(ws, pn, 'مرحبا', g, CLOSED_SAT))[0]!.body.text.body).toBe(AWAY.ar);
  });

  it('with ordersWhileClosed off the away message replaces the bot, and a second message in the period gets silence', async () => {
    const { ws, pn } = await setup(2, hours({ ordersWhileClosed: false }));
    const g = stubGraph();
    const first = await say(ws, pn, 'مرحبا', g, CLOSED_THU);
    expect(first.map((s) => s.body.text?.body)).toEqual([AWAY.ar]);
    expect(await say(ws, pn, 'مرحبا', g, CLOSED_THU + 60_000)).toEqual([]);
    // opening again restores the bot
    expect((await say(ws, pn, 'مرحبا', g, OPEN_SAT)).length).toBeGreaterThan(1);
  });

  it('open hours and disabled hours change nothing', async () => {
    for (const [n, h, now] of [[3, hours(), OPEN_SAT], [4, hours({ enabled: false }), CLOSED_THU], [5, null, CLOSED_THU]] as const) {
      const { ws, pn } = await setup(n, h);
      const g = stubGraph();
      const out = await say(ws, pn, 'hi', g, now);
      expect(out.map((s) => s.kind)).toEqual(['text', ...Array(9).fill('image'), 'list']);
      expect(out[0]!.body.text.body).toContain('متجر الاختبار');
    }
  });

  it('the AI agent follows the same switch', async () => {
    // One clock (WA-FLAKE-AWAY-1): the turn ran at CLOSED_THU while the send claim read the real Date.now(); fake only Date so both agree.
    vi.useFakeTimers({ toFake: ['Date'], now: CLOSED_THU });
    try {
      for (const [n, orders] of [[6, false], [7, true]] as const) {
        const { ws, pn } = await setup(n, hours({ ordersWhileClosed: orders }));
        expect((await workspace(ws).setAgentSettings({ enabled: true })).ok).toBe(true);
        await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
        const model = (agent.model = new ScriptedProvider([{ text: 'تمام' }])) as ScriptedProvider;
        const g = stubGraph();
        const out = await say(ws, pn, 'عندكم ورد؟', g, Date.now());
        expect(out[0]!.body.text.body).toBe(AWAY.ar);
        expect(model.calls).toHaveLength(orders ? 1 : 0);
        expect(out.length).toBe(orders ? 2 : 1);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a person who has the conversation is not talked over by the away message', async () => {
    const { ws, pn } = await setup(8, hours());
    await runInDurableObject(workspace(ws), (_i, state) => { state.storage.sql.exec("INSERT INTO agent_handoffs (wa_id, started_at, until_at, reason) VALUES (?, 1, ?, 'staff')", WA_1, CLOSED_THU + 3_600_000); });
    const g = stubGraph();
    expect(await say(ws, pn, 'hi', g, CLOSED_THU)).toEqual([]);
  });
});

describe('away message and erasure', () => {
  it('erasing the customer forgets that they were told, so no trace of the number stays in the shop state', async () => {
    const { ws, pn } = await setup(9, hours({ ordersWhileClosed: false }));
    const g = stubGraph();
    await say(ws, pn, 'مرحبا', g, CLOSED_THU);
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'away:%'")).toHaveLength(1);
    await workspace(ws).eraseContact(WA_1);
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'away:%'")).toHaveLength(0);
  });
});

describe('away message and a customer erased in flight', () => {
  it('a customer erased while the away message is being sent leaves no state row behind', async () => {
    const { ws, pn } = await setup(10, hours({ ordersWhileClosed: false }));
    const hp = holdPoint();
    const g = stubGraph(undefined, { before: () => hp.hold() });
    const turn = say(ws, pn, 'مرحبا', g, CLOSED_THU);
    await hp.reached();
    await workspace(ws).eraseContact(WA_1);
    hp.release();
    await turn;
    expect(await rows(ws, "SELECT 1 FROM store_state WHERE key LIKE 'away:%'")).toEqual([]);
    expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
  });
});

describe('business hours settings route', () => {
  it('validates ranges, the fixed timezone and Meta limits for the away message', async () => {
    const id = storeId(6201);
    const owner = await apiFor(id);
    const staff = await apiFor(id, 'staff');
    const patch = (h: unknown, who = owner) => who.call('PATCH', '/store-link/settings', { hours: h }).then((r) => r.status);
    expect(await patch(hours())).toBe(200);
    expect((await (await owner.call('GET', '/store-link/settings')).json() as any).hours.ordersWhileClosed).toBe(true);
    expect(await patch(hours(), staff)).toBe(403);
    expect(await patch(hours({ timezone: 'Europe/London' as never }))).toBe(400);
    expect(await patch(hours({ week: week({ 0: [{ open: '25:00', close: '18:00' }] }) }))).toBe(400);
    expect(await patch(hours({ week: week({ 0: [{ open: '10:00', close: '10:00' }] }) }))).toBe(400);
    expect(await patch(hours({ week: week({ 0: [{ open: '1:00', close: '18:00' }] }) }))).toBe(400);
    expect(await patch(hours({ week: week({ 0: [{ open: '08:00', close: '10:00' }, { open: '11:00', close: '12:00' }, { open: '13:00', close: '14:00' }] }) }))).toBe(400);
    expect(await patch(hours({ awayMessage: { ar: 'ا'.repeat(1025), en: 'x' } }))).toBe(400);
    expect(await patch(hours({ awayMessage: { ar: '', en: 'x' } }))).toBe(400);
  });
});

describe('the away message always goes before any bot or agent reply (WA-FLAKE-AWAY-1)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: CLOSED_THU }); });
  afterEach(() => { vi.useRealTimers(); });
  const closed = week();

  it('when the away message could not be sent yet (its claim was deferred), nothing else is sent in that turn', async () => {
    const { ws, pn } = await setup(20, hours({ week: closed, ordersWhileClosed: true }));
    expect((await workspace(ws).setAgentSettings({ enabled: true })).ok).toBe(true);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
    agent.model = new ScriptedProvider([{ text: 'تمام' }]);
    // What a throttle / wallet wait / an in-flight claim does to deliverNow: the away job is not sent now.
    await runInDurableObject(workspace(ws), (i) => {
      const d = i as unknown as { deliverNow: (job: { idempotencyKey: string }) => Promise<void> };
      const orig = d.deliverNow.bind(d);
      d.deliverNow = async (job) => (job.idempotencyKey.startsWith('away:') ? undefined : orig(job));
    });
    const g = stubGraph();
    expect(await say(ws, pn, 'عندكم ورد؟', g, Date.now())).toEqual([]); // no agent answer ahead of "we are closed"
  });

  it('a second message while the first away message is still waiting to go: still nothing ahead of it', async () => {
    const { ws, pn } = await setup(22, hours({ week: closed, ordersWhileClosed: true }));
    expect((await workspace(ws).setAgentSettings({ enabled: true })).ok).toBe(true);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
    agent.model = new ScriptedProvider([{ text: 'تمام' }, { text: 'أكيد' }]);
    await runInDurableObject(workspace(ws), (i) => {
      const d = i as unknown as { deliverNow: (job: { idempotencyKey: string }) => Promise<void> };
      const orig = d.deliverNow.bind(d);
      d.deliverNow = async (job) => (job.idempotencyKey.startsWith('away:') ? undefined : orig(job));
    });
    const g = stubGraph();
    expect(await say(ws, pn, 'عندكم ورد؟', g, Date.now())).toEqual([]);
    expect(await say(ws, pn, 'وكمان شوكولاتة؟', g, Date.now() + 60_000)).toEqual([]);
  });

  it('with real interleaving (every Meta call takes 40 ms), two quick messages from the customer: the away message is first on the wire', async () => {
    const { ws, pn } = await setup(21, hours({ week: closed, ordersWhileClosed: true }));
    expect((await workspace(ws).setAgentSettings({ enabled: true })).ok).toBe(true);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 100 });
    agent.model = new ScriptedProvider([{ text: 'تمام' }, { text: 'أكيد' }]);
    const g = stubGraph(undefined, { delayMs: 40 });
    await Promise.all([say(ws, pn, 'عندكم ورد؟', g, Date.now()), say(ws, pn, 'وكمان شوكولاتة؟', g, Date.now())]);
    const texts = sentOf(g, pn).map((m) => m.body.text?.body);
    expect(texts[0]).toBe(AWAY.ar);
    expect(texts.filter((t) => t === AWAY.ar)).toHaveLength(1); // once per closed period
  });
});
