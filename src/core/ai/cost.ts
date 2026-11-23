/**
 * What an AI turn costs the PLATFORM, and the per-plan alert on it (M-084). A credit is sold at a package price / package credits; the model costs per token.
 * The alert fires when the average cost per credit of a workspace passes HALF the plan's break-even, so margin erosion shows long before it is a loss.
 * Money here is EGP MICROS (1,000,000 = 1 EGP), integers; prices are USD per million tokens (which is numerically micro-USD per token).
 */
import type { Env } from '../../env';
import { alert } from '../observability';
import { fxAt } from '../billing/pricing';
import { readEntitlement } from '../billing/entitlements';
import { isFlaggedModel } from './model-flag';

/** 50% of break-even per credit, from WA-PRICE-1 (break-even: the 300-reply package 2.0, 1,500 0.90, 5,000 0.67 EGP): 1.00, 0.45, 0.33 EGP (ids `starter`, `growth`, `pro` are internal codes). */
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
export function modelPrices(env: Pick<Env, 'AI_PRICE_INPUT_USD_PER_M' | 'AI_PRICE_OUTPUT_USD_PER_M' | 'AI_PRICE_INPUT_USD_PER_M_GPT_OSS' | 'AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS'>, model: string | null = null): ModelPrices | null {
  // Ruling WA-MODEL-FLAG-1: the flagged model has its own prices; unset = cost unknown (never the other model's price).
  const flagged = isFlaggedModel(model);
  const inRaw = flagged ? env.AI_PRICE_INPUT_USD_PER_M_GPT_OSS : env.AI_PRICE_INPUT_USD_PER_M;
  const outRaw = flagged ? env.AI_PRICE_OUTPUT_USD_PER_M_GPT_OSS : env.AI_PRICE_OUTPUT_USD_PER_M;
  const i = Number(inRaw);
  const o = Number(outRaw);
  return inRaw && outRaw && Number.isFinite(i) && Number.isFinite(o) && i >= 0 && o >= 0 ? { inputUsdPerM: i, outputUsdPerM: o } : null;
}

/** Voice notes: the speech model's price per audio minute in USD (`AI_STT_PRICE_USD_PER_MIN`), or null when unset (then the audio's cost is unknown, never guessed). */
export function sttPriceUsdPerMin(env: Pick<Env, 'AI_STT_PRICE_USD_PER_MIN'>): number | null {
  const p = Number(env.AI_STT_PRICE_USD_PER_MIN);
  return env.AI_STT_PRICE_USD_PER_MIN && Number.isFinite(p) && p >= 0 ? p : null;
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
export function recordTurnCost(host: { env: Env; sql: Sql; workspaceId: string }, tokens: { inputTokens: number; outputTokens: number; /** Voice note audio transcribed in this turn (always the platform's cost, even with the merchant's own model key). */ audioMs?: number }, byoKey: boolean, now: number, model: string | null = null): number {
  const sttPrice = sttPriceUsdPerMin(host.env);
  const fx = fxAt(host.sql, now);
  if (!fx) return 0;
  const audio = sttPrice !== null && tokens.audioMs ? Math.round(((tokens.audioMs / 60_000) * sttPrice * fx.micros)) : 0;
  const prices = byoKey ? null : modelPrices(host.env, model); // a merchant's own model key: the merchant pays that provider
  if (byoKey && audio === 0) return 0;
  if (!byoKey && !prices) return 0;
  const cost = (prices ? turnCostEgpMicros(tokens, prices, fx.micros) : 0) + audio;
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
