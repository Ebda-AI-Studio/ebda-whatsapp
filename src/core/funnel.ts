import type { Env } from '../env';

/**
 * The signup-to-paid funnel as Analytics Engine points (T12). One point per step, in the same dataset as the pipeline timings (`USAGE`):
 * blobs = [`funnel.<step>`, workspaceId, detail], doubles = [1], indexes = [`funnel.<step>`]. `detail` is a fixed vocabulary (a package id), never a phone number,
 * a name or a message. docs/analytics.md has the SQL: "first time" of a step is `min(timestamp)` per workspace, so a step that can repeat needs no dedupe.
 */
export type FunnelStep = 'linked' | 'number_connected' | 'first_inbound' | 'first_ai_reply' | 'package_purchased' | 'topup_credited';

export function funnel(env: Pick<Env, 'USAGE'>, step: FunnelStep, workspaceId: string, detail = ''): void {
  try {
    env.USAGE.writeDataPoint({ blobs: [`funnel.${step}`, workspaceId, detail.slice(0, 64)], doubles: [1], indexes: [`funnel.${step}`] });
  } catch {
    // Analytics is best-effort: a measurement never breaks the path it measures.
  }
}

/** Emits `step` the first time this workspace reaches it (a marker row in `store_state`), for steps inside the Durable Object where "first" is not a SQL question. */
export function funnelOnce(host: { env: Pick<Env, 'USAGE'>; workspaceId: string; sql: DurableObjectStorage['sql'] }, step: FunnelStep): void {
  try {
    if (host.sql.exec("INSERT OR IGNORE INTO store_state (key, value) VALUES (?, '1')", `funnel.${step}`).rowsWritten > 0) funnel(host.env, step, host.workspaceId);
  } catch {
    // never breaks the path it measures
  }
}
