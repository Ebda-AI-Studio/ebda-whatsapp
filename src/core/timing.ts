import type { Env } from '../env';

export type Stage = 'webhook_ack' | 'do_stored' | 'enqueued' | 'meta_accepted' | 'unrouted';

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
