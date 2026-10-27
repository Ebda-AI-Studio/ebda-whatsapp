import type { Env } from '../env';

export type Stage = 'webhook_ack' | 'do_stored' | 'enqueued' | 'meta_accepted' | 'unrouted';

/**
 * One AI turn's cost drivers (T26b): blobs = ['ai_turn', workspaceId, outcome], doubles = [input tokens, output tokens, model rounds, milliseconds, credits charged].
 * Cost per reply is read from these (docs/analytics.md); it is measured, not assumed. Never throws.
 */
export function markAiTurn(env: Pick<Env, 'USAGE'>, workspaceId: string, t: { outcome: string; inputTokens: number; outputTokens: number; rounds: number; ms: number; credits: number }): void {
  try {
    env.USAGE.writeDataPoint({ blobs: ['ai_turn', workspaceId, t.outcome], doubles: [t.inputTokens, t.outputTokens, t.rounds, t.ms, t.credits], indexes: ['ai_turn'] });
  } catch {
    // Analytics is best-effort.
  }
}

/**
 * One Analytics Engine point per pipeline stage: doubles = [ms since Meta's message timestamp, ms since webhook receipt].
 * Either may be 0 when unknown. Never throws: timing must not break delivery.
 */
export function mark(env: Pick<Env, 'USAGE'>, stage: Stage, msSinceMetaTs: number, msSinceReceipt: number, workspaceId = ''): void {
  try {
    env.USAGE.writeDataPoint({ blobs: [stage, workspaceId], doubles: [msSinceMetaTs, msSinceReceipt], indexes: [stage] });
  } catch {
    // Analytics is best-effort.
  }
}
