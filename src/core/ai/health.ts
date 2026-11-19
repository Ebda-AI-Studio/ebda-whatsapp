/**
 * Platform-wide AI health, for two alerts the per-workspace Durable Objects cannot raise (AGENT-HEALTH-1, the flip sequence of CHAT-EVAL-BAR-1b):
 *  - `agent_reply_blocked_rate` (P1): the reply guard refused more than 3% of the AI turns of one hour (a model that started hallucinating money or links shows here first);
 *  - `ai_cost_per_1k_over_threshold` (P1): the platform-paid AI cost per 1k turns passed 2 USD over one UTC day (CHAT-EVAL-BAR-1 cost gate; a turn is at most one conversation message, so this
 *    is a slightly generous reading of "per 1k conversations").
 * One D1 upsert pair per AI turn (hour row + day row); each alert fires AT MOST ONCE per hour / day (a flag column claimed with a conditional UPDATE). Best-effort: it never throws and never delays the turn.
 * Cost uses the configured per-million prices of the model that answered (`modelPrices`); a turn with no known price or on the merchant's own key adds a turn but no cost, and the cost rate divides
 * by PAID turns only.
 */
import type { Env } from '../../env';
import { alert } from '../observability';
import { modelPrices } from './cost';

export const BLOCKED_RATE_MAX = 0.03;
/** Fewer turns than this in the window is noise (one refusal in five turns is 20%). */
export const MIN_TURNS_FOR_BLOCKED_ALERT = 20;
export const COST_USD_PER_1K_MAX = 2;
export const MIN_PAID_TURNS_FOR_COST_ALERT = 200;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const RETENTION_MS = 8 * DAY;

type Row = { kind: string; slot: number; turns: number; blocked: number; paid_turns: number; cost_usd_micros: number };

/** Records one AI turn (a turn that made at least one model call). `blocked` = the reply guard refused the model's reply. */
export async function recordAgentHealth(env: Env, t: { model: string | null; byoKey: boolean; blocked: boolean; inputTokens: number; outputTokens: number }, now = Date.now()): Promise<void> {
  try {
    const prices = t.byoKey ? null : modelPrices(env, t.model);
    const costMicros = prices ? Math.round(t.inputTokens * prices.inputUsdPerM + t.outputTokens * prices.outputUsdPerM) : 0;
    const paid = prices ? 1 : 0;
    const hour = Math.floor(now / HOUR);
    const day = Math.floor(now / DAY);
    const upsert = env.DB.prepare(
      `INSERT INTO agent_health (kind, slot, turns, blocked, paid_turns, cost_usd_micros) VALUES (?1, ?2, 1, ?3, ?4, ?5)
       ON CONFLICT(kind, slot) DO UPDATE SET turns = turns + 1, blocked = blocked + ?3, paid_turns = paid_turns + ?4, cost_usd_micros = cost_usd_micros + ?5
       RETURNING kind, slot, turns, blocked, paid_turns, cost_usd_micros`,
    );
    const [h, d] = await env.DB.batch<Row>([upsert.bind('h', hour, t.blocked ? 1 : 0, paid, costMicros), upsert.bind('d', day, t.blocked ? 1 : 0, paid, costMicros)]);
    const hr = h?.results?.[0];
    const dr = d?.results?.[0];
    if (hr && hr.turns >= MIN_TURNS_FOR_BLOCKED_ALERT && hr.blocked / hr.turns > BLOCKED_RATE_MAX) {
      const claimed = await env.DB.prepare("UPDATE agent_health SET alerted_blocked = 1 WHERE kind = 'h' AND slot = ? AND alerted_blocked = 0").bind(hour).run();
      if (claimed.meta.changes) alert('agent_reply_blocked_rate', { window: '1h', turns: hr.turns, blocked: hr.blocked, ratePct: Number(((hr.blocked / hr.turns) * 100).toFixed(1)), model: t.model ?? 'default' });
    }
    if (dr && dr.paid_turns >= MIN_PAID_TURNS_FOR_COST_ALERT && (dr.cost_usd_micros / dr.paid_turns) * 1000 / 1_000_000 > COST_USD_PER_1K_MAX) {
      const claimed = await env.DB.prepare("UPDATE agent_health SET alerted_cost = 1 WHERE kind = 'd' AND slot = ? AND alerted_cost = 0").bind(day).run();
      if (claimed.meta.changes) alert('ai_cost_per_1k_over_threshold', { window: '1d', paidTurns: dr.paid_turns, usdPer1k: Number((((dr.cost_usd_micros / dr.paid_turns) * 1000) / 1_000_000).toFixed(2)), thresholdUsdPer1k: COST_USD_PER_1K_MAX });
    }
  } catch {
    // health counters are best-effort: a failed write must never touch the customer's turn
  }
}

/** The current hour and day, for the operator read-back during the 24 h watch. */
export async function readAgentHealth(env: Pick<Env, 'DB'>, now = Date.now()): Promise<{ hour: HealthView; day: HealthView }> {
  const get = async (kind: 'h' | 'd', slot: number): Promise<HealthView> => {
    const r = await env.DB.prepare('SELECT turns, blocked, paid_turns, cost_usd_micros FROM agent_health WHERE kind = ? AND slot = ?').bind(kind, slot).first<Row>();
    const turns = r?.turns ?? 0;
    const paid = r?.paid_turns ?? 0;
    return { turns, blocked: r?.blocked ?? 0, blockedRatePct: turns ? Number((((r?.blocked ?? 0) / turns) * 100).toFixed(2)) : 0, paidTurns: paid, usdPer1kTurns: paid ? Number((((r?.cost_usd_micros ?? 0) / paid) * 1000 / 1_000_000).toFixed(3)) : null };
  };
  return { hour: await get('h', Math.floor(now / HOUR)), day: await get('d', Math.floor(now / DAY)) };
}
export type HealthView = { turns: number; blocked: number; blockedRatePct: number; paidTurns: number; usdPer1kTurns: number | null };

/** Daily cron: drop counters older than 8 days. */
export async function pruneAgentHealth(env: Pick<Env, 'DB'>, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM agent_health WHERE (kind = 'h' AND slot < ?) OR (kind = 'd' AND slot < ?)").bind(Math.floor((now - RETENTION_MS) / HOUR), Math.floor((now - RETENTION_MS) / DAY)).run();
  } catch { /* best-effort */ }
}
