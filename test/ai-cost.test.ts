import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { AI_COST_ALERT_EGP_MICROS, MIN_TURNS_FOR_COST_ALERT, alertThresholdFor, turnCostEgpMicros } from '../src/core/ai/cost';
import { MAX_MODEL_CALLS_PER_CREDIT } from '../src/core/ai/agent';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

// M-084: the credit is one AI turn, a turn makes at most 4 model calls, the platform's cost per credit is logged per workspace, and a plan alerts at 50% of its break-even.
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000094${String(n).padStart(2, '0')}`;
const FX = 50_000_000; // 50 EGP per USD
type Point = AnalyticsEngineDataPoint;

describe('the arithmetic', () => {
  it('turns tokens into EGP micros with the configured per-million prices and the workspace\'s FX', () => {
    // 1,000 in x 0.293 + 500 out x 2.253 = 1,419.5 micro-USD; at 50 EGP/USD = 70,975 EGP micros (0.071 EGP)
    expect(turnCostEgpMicros({ inputTokens: 1000, outputTokens: 500 }, { inputUsdPerM: 0.293, outputUsdPerM: 2.253 }, FX)).toBe(70_975);
    expect(turnCostEgpMicros({ inputTokens: 0, outputTokens: 0 }, { inputUsdPerM: 0.293, outputUsdPerM: 2.253 }, FX)).toBe(0);
  });
  it('the alert thresholds are 50% of break-even per credit: Starter 1.00, Growth 0.45, Pro 0.33 EGP, the yearly twins the same, store-included none', () => {
    expect(AI_COST_ALERT_EGP_MICROS).toEqual({ starter: 1_000_000, growth: 450_000, pro: 330_000, 'starter-yearly': 1_000_000, 'growth-yearly': 450_000, 'pro-yearly': 330_000 });
    expect(alertThresholdFor('pro')).toBe(330_000);
    expect(alertThresholdFor('store-included')).toBeNull();
    expect(alertThresholdFor('gold')).toBeNull();
    expect(MIN_TURNS_FOR_COST_ALERT).toBe(10);
  });
});

async function proWorkspace(ws: string, pkg = 'pro') {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  await exec(ws, 'UPDATE entitlements SET package_id = ?', pkg);
  await exec(ws, 'INSERT OR IGNORE INTO pricing_fx (src_id, ver, effective_from, egp_per_usd_micros, buffer_bps) VALUES (1, 1, 0, ?, 0)', FX);
  return pn;
}

describe('cost per credit is logged per workspace', () => {
  it('every turn writes its cost in EGP micros next to its tokens; an unpriced model writes 0 and says nothing else', async () => {
    const ws = W(1);
    const pn = await proWorkspace(ws);
    agent.model = new ScriptedProvider([{ text: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } }]);
    const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
    const g = stubGraph();
    await say(ws, pn, text('hi'), g);
    const p = ae.mock.calls.map((c) => c[0] as Point).find((x) => x.blobs?.[0] === 'ai_turn')!;
    expect(p.doubles).toEqual([1000, 500, 1, expect.any(Number), 1, 70_975]);
    g.restore();
  });
});

describe('the alert fires when a plan\'s cost per credit passes half its break-even', () => {
  const run = async (ws: string, pkg: string, outTokens: number, turns: number) => {
    const pn = await proWorkspace(ws, pkg);
    agent.model = new ScriptedProvider(Array.from({ length: turns }, () => ({ text: 'ok', usage: { inputTokens: 100, outputTokens: outTokens } })));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const g = stubGraph();
    for (let i = 0; i < turns; i++) await say(ws, pn, text(`m${i}`), g);
    g.restore();
    spy.mockRestore();
    return logs.filter((l) => l.includes('"alert":"ai_cost_over_threshold"'));
  };
  it('Pro with 3,000 output tokens a turn (about 0.34 EGP): once the 10th turn is in, not before, and once a day', async () => {
    const hits = await run(W(2), 'pro', 3000, 12);
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!)).toMatchObject({ alert: 'ai_cost_over_threshold', workspace: W(2), package: 'pro', thresholdEgpMicros: 330_000 });
    expect(JSON.parse(hits[0]!).avgEgpMicros).toBeGreaterThan(330_000);
  });
  it('the same cost on Starter (threshold 1.00 EGP) is fine', async () => {
    expect(await run(W(3), 'starter', 3000, 12)).toHaveLength(0);
  });
  it('a cheap Pro workspace never alerts, and nothing alerts before 10 turns', async () => {
    expect(await run(W(4), 'pro', 200, 12)).toHaveLength(0);
    expect(await run(W(5), 'pro', 3000, 9)).toHaveLength(0);
  });
});

describe('the cap: one credit buys at most 4 model calls', () => {
  it('a model that asks for tools forever is cut at MAX_MODEL_CALLS_PER_CREDIT, hands over, and costs exactly one credit', async () => {
    expect(MAX_MODEL_CALLS_PER_CREDIT).toBe(4);
    const ws = W(6);
    const pn = await proWorkspace(ws);
    const again = { tools: [{ name: 'search_catalog', arguments: { query: 'x' } }] };
    const m = (agent.model = new ScriptedProvider([again, again, again, again, again, again])) as ScriptedProvider;
    const g = stubGraph();
    await say(ws, pn, text('عايز كل حاجة'), g);
    expect(m.callCount).toBeLessThanOrEqual(MAX_MODEL_CALLS_PER_CREDIT);
    expect(await rows(ws, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ n: 1 }]);
    g.restore();
  });
});
