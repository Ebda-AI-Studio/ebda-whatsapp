/**
 * What an AI turn costs the PLATFORM, and the per-plan alert on it (M-084). A credit is sold at a package price / package credits; the model costs per token.
 * The alert fires when the average cost per credit of a workspace passes HALF the plan's break-even, so margin erosion shows long before it is a loss.
 * Money here is EGP MICROS (1,000,000 = 1 EGP), integers; prices are USD per million tokens (which is numerically micro-USD per token).
 */
import type { Env } from '../../env';
import { alert } from '../observability';
import { fxAt } from '../billing/pricing';
import { readEntitlement } from '../billing/entitlements';

/** 50% of break-even per credit, from WA-PRICE-1 (break-even: Starter 2.0, Growth 0.90, Pro 0.67 EGP): Starter 1.00, Growth 0.45, Pro 0.33 EGP. */
export const AI_COST_ALERT_EGP_MICROS: Readonly<Record<string, number>> = {
  starter: 1_000_000, growth: 450_000, pro: 330_000,
  'starter-yearly': 1_000_000, 'growth-yearly': 450_000, 'pro-yearly': 330_000, // same credits per month as their monthly twin
};
export const alertThresholdFor = (packageId: string | null | undefined): number | null => (packageId ? (AI_COST_ALERT_EGP_MICROS[packageId] ?? null) : null);
/** A single expensive turn is noise: the average is judged only after this many turns. */
export const MIN_TURNS_FOR_COST_ALERT = 10;
const EWMA_WEIGHT = 0.2;
const DAY = 86_400_000;

export type ModelPrices = { inputUsdPerM: number; outputUsdPerM: number };
/** The configured per-million-token prices of the platform's model, or null when unset / unreadable (then cost is unknown, never guessed). */
export function modelPrices(env: Pick<Env, 'AI_PRICE_INPUT_USD_PER_M' | 'AI_PRICE_OUTPUT_USD_PER_M'>): ModelPrices | null {
  const i = Number(env.AI_PRICE_INPUT_USD_PER_M);
  const o = Number(env.AI_PRICE_OUTPUT_USD_PER_M);
  return env.AI_PRICE_INPUT_USD_PER_M && env.AI_PRICE_OUTPUT_USD_PER_M && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 ? { inputUsdPerM: i, outputUsdPerM: o } : null;
}

export function turnCostEgpMicros(t: { inputTokens: number; outputTokens: number }, p: ModelPrices, egpPerUsdMicros: number): number {
  return Math.round(((t.inputTokens * p.inputUsdPerM + t.outputTokens * p.outputUsdPerM) * egpPerUsdMicros) / 1_000_000);
}

type Sql = DurableObjectStorage['sql'];
const state = (sql: Sql, k: string): number => Number(sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', k).toArray()[0]?.value ?? 0);
const put = (sql: Sql, k: string, v: number): void => { sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v)); };

/**
 * Records one turn's cost for the workspace (a rolling average per credit) and raises `ai_cost_over_threshold` (P1) once a day while the average is over the
 * plan's threshold. Returns the turn's cost in EGP micros (0 = unknown or not the platform's cost: own model key, no prices, no FX).
 */
export function recordTurnCost(host: { env: Env; sql: Sql; workspaceId: string }, tokens: { inputTokens: number; outputTokens: number }, byoKey: boolean, now: number): number {
  if (byoKey) return 0; // the merchant pays their own model provider
  const prices = modelPrices(host.env);
  const fx = fxAt(host.sql, now);
  if (!prices || !fx) return 0;
  const cost = turnCostEgpMicros(tokens, prices, fx.micros);
  const turns = state(host.sql, 'ai.cost_turns');
  const avg = turns === 0 ? cost : state(host.sql, 'ai.cost_avg') * (1 - EWMA_WEIGHT) + cost * EWMA_WEIGHT;
  put(host.sql, 'ai.cost_avg', Math.round(avg));
  put(host.sql, 'ai.cost_turns', Math.min(turns + 1, 1_000_000));
  const pkg = readEntitlement(host.sql)?.packageId ?? null;
  const threshold = alertThresholdFor(pkg);
  if (threshold !== null && turns + 1 >= MIN_TURNS_FOR_COST_ALERT && avg > threshold && now - state(host.sql, 'ai.cost_alert_at') >= DAY) {
    put(host.sql, 'ai.cost_alert_at', now);
    alert('ai_cost_over_threshold', { workspace: host.workspaceId, package: pkg, avgEgpMicros: Math.round(avg), thresholdEgpMicros: threshold });
  }
  return cost;
}
