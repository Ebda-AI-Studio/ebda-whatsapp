import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COST_USD_PER_1K_MAX, MIN_PAID_TURNS_FOR_COST_ALERT, MIN_TURNS_FOR_BLOCKED_ALERT, pruneAgentHealth, readAgentHealth, recordAgentHealth } from '../src/core/ai/health';
import { GPT_OSS_MODEL } from '../src/core/ai/model-flag';
import { bindAlerts, resetAlerts } from '../src/core/observability';
import type { Env } from '../src/env';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

// AGENT-HEALTH-1 (CHAT-EVAL-BAR-1b flip sequence): the two platform alerts, through the REAL alert pipeline (Sentry capture + the Telegram sendMessage) with the runbook link.
const SECRETS = { TELEGRAM_BOT_TOKEN: '123456:AAF-test-token', TELEGRAM_ALERT_CHAT_ID: '-1001234567', ALERT_PRODUCT: 'Ebda Chat' };
const PRICED = { ...env, AI_PRICE_INPUT_USD_PER_M_GPT_OSS: '0.35', AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS: '0.75' } as unknown as Env;
type H = { telegram: string[]; messages: string[]; waits: Promise<unknown>[]; flush(): Promise<void> };
function harness(): H {
  const h: H = { telegram: [], messages: [], waits: [], flush: async () => { await Promise.allSettled(h.waits); } };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch ${url}`);
    h.telegram.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return new Response('{"ok":true}');
  });
  bindAlerts({ env: SECRETS, waitUntil: (p) => { h.waits.push(p); }, captureMessage: (m) => { h.messages.push(m); }, captureException: () => undefined });
  return h;
}
let t0 = 0;
beforeEach(async () => { resetAlerts(); vi.spyOn(console, 'error').mockImplementation(() => {}); await env.DB.prepare('DELETE FROM agent_health').run(); t0 = Date.UTC(2026, 10, 20, 12, 30); });
afterEach(() => { resetAlerts(); vi.restoreAllMocks(); });
const turn = (blocked: boolean, over: Partial<Parameters<typeof recordAgentHealth>[1]> = {}, at = t0) => recordAgentHealth(PRICED, { model: GPT_OSS_MODEL, byoKey: false, blocked, inputTokens: 2000, outputTokens: 150, ...over }, at);

describe('agent_reply_blocked_rate (P1): more than 3% of the turns of one hour', () => {
  it('fires once at the crossing, names the runbook, and not again in the same hour', async () => {
    const h = harness();
    for (let i = 0; i < MIN_TURNS_FOR_BLOCKED_ALERT - 1; i++) await turn(i === 0); // 1 blocked in 19 turns: below the minimum number of turns, quiet
    await h.flush();
    expect(h.telegram).toEqual([]);
    await turn(false); // 1 in 20 = 5% over 20 turns
    await h.flush();
    expect(h.telegram).toHaveLength(1);
    expect(h.telegram[0]).toContain('agent_reply_blocked_rate');
    expect(h.telegram[0]).toContain('runbook=docs/runbooks/alerts/agent_reply_blocked_rate.md');
    expect(h.messages).toHaveLength(1); // the Sentry event
    resetAlerts(); // forget the alert throttle (a restarted isolate): the claim in D1 must still hold the alert back for the rest of the hour
    const h2 = harness();
    await turn(true); await turn(true);
    await h2.flush();
    expect(h2.telegram).toEqual([]); // once per hour, by the D1 claim, not by the in-memory throttle
    await turn(true, {}, t0 + 3_600_000 * 2); // a new hour starts clean
    expect((await readAgentHealth(env, t0 + 3_600_000 * 2)).hour).toMatchObject({ turns: 1, blocked: 1 });
  });
  it('exactly at 3% does not fire; just above does', async () => {
    const h = harness();
    for (let i = 0; i < 100; i++) await turn([34, 67, 100].includes(i + 1)); // 3 of 100 = 3.0%, placed so the running rate never passes 3% before the end
    await h.flush();
    expect(h.telegram).toEqual([]);
    await turn(true); // 4 of 101
    await h.flush();
    expect(h.telegram).toHaveLength(1);
  });
});

describe('ai_cost_per_1k_over_threshold (P1): platform-paid cost per 1k turns over a UTC day', () => {
  it('fires once when the day passes 2 USD per 1k turns, not before the minimum of paid turns', async () => {
    const h = harness();
    // 8,000 input + 4,000 output tokens per turn at 0.35 / 0.75 USD per M = 0.0058 USD a turn = 5.8 USD per 1k
    for (let i = 0; i < MIN_PAID_TURNS_FOR_COST_ALERT - 1; i++) await turn(false, { inputTokens: 8000, outputTokens: 4000 });
    await h.flush();
    expect(h.telegram).toEqual([]);
    await turn(false, { inputTokens: 8000, outputTokens: 4000 });
    await h.flush();
    expect(h.telegram).toHaveLength(1);
    expect(h.telegram[0]).toContain('ai_cost_per_1k_over_threshold');
    expect(h.telegram[0]).toContain('runbook=docs/runbooks/alerts/ai_cost_per_1k_over_threshold.md');
    resetAlerts(); // the D1 claim, not the in-memory throttle, holds the alert back for the rest of the day
    const h2 = harness();
    await turn(false, { inputTokens: 8000, outputTokens: 4000 });
    await h2.flush();
    expect(h2.telegram).toEqual([]); // once per day
  });
  it('a normal day (about 1.9 USD per 1k as measured in the live eval) stays quiet, and the own-key and unpriced turns add no cost and no divisor', async () => {
    const h = harness();
    for (let i = 0; i < 300; i++) await turn(false, { inputTokens: 4800, outputTokens: 310 }); // 4800*.35 + 310*.75 = 1912.5 micro-USD a turn = 1.91 USD per 1k
    for (let i = 0; i < 300; i++) await turn(false, { byoKey: true, inputTokens: 50_000, outputTokens: 5000 }); // the merchant's own key: not the platform's cost
    await recordAgentHealth(env as unknown as Env, { model: GPT_OSS_MODEL, byoKey: false, blocked: false, inputTokens: 99_999, outputTokens: 9999 }, t0); // no price configured: cost unknown, never guessed
    await h.flush();
    expect(h.telegram).toEqual([]);
    const day = (await readAgentHealth(env, t0)).day;
    expect(day.paidTurns).toBe(300);
    expect(day.usdPer1kTurns).toBeGreaterThan(1.9);
    expect(day.usdPer1kTurns).toBeLessThan(COST_USD_PER_1K_MAX);
  });
});

describe('plumbing', () => {
  it('prune drops counters older than 8 days and keeps newer ones', async () => {
    await turn(false, {}, t0 - 9 * 86_400_000);
    await turn(false, {}, t0 - 2 * 86_400_000);
    await pruneAgentHealth(env, t0);
    const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_health').first<{ n: number }>())!.n;
    expect(n).toBe(2); // the recent hour row and day row
  });
  it('a failing database never throws into the turn', async () => {
    await expect(recordAgentHealth({ ...PRICED, DB: { prepare: () => { throw new Error('d1 down'); } } } as unknown as Env, { model: null, byoKey: false, blocked: true, inputTokens: 1, outputTokens: 1 })).resolves.toBeUndefined();
  });
});

describe('the agent turn feeds the counters (hook)', () => {
  useStoreLink();
  const agent = useAgent();
  it('a refused reply counts as a blocked AI turn, a normal one as a plain turn', async () => {
    const ws = '00000000-0000-4000-8000-000000009991';
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
    agent.model = new ScriptedProvider([{ text: 'أهلاً بيك' }, { text: 'تعالى خد خصم 50% دلوقتي' }]); // the 2nd reply is a discount promise nobody vouched for: the guard refuses it
    const g = stubGraph();
    await say(ws, pn, text('مساء الخير', '201555000888'), g);
    await say(ws, pn, text('عندكم عروض؟', '201555000888'), g);
    g.restore();
    await new Promise((r) => setTimeout(r, 50));
    const v = await readAgentHealth(env);
    expect(v.hour.turns).toBeGreaterThanOrEqual(2);
    expect(v.hour.blocked).toBeGreaterThanOrEqual(1);
  });
});
