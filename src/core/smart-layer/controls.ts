/**
 * Rollout controls for the Chat assistant. The per-workspace flag lives in its Durable Object (default off, set only by an operator); the platform switches
 * (global kill, Chat kill, global mode cap, killed tools) live in D1 `platform_flags` so they change without a deploy.
 *
 * Staleness class: NEVER-stale (a kill switch). Nothing here is cached: every turn reads D1 and the DO, and the engine reads them again at apply time.
 * An unreadable switch fails CLOSED: the assistant is off until D1 answers.
 */
import { resolveControls, type RawControls } from '../../../foundation/smart-layer/controls';
import type { Controls, Mode } from '../../../foundation/smart-layer/types';
import type { Env } from '../../env';
import { alert, errClass } from '../observability';

export const FLAG = { global: 'sl.global', product: 'sl.product.chat', tools: 'sl.tools' } as const;
const MODES: readonly Mode[] = ['off', 'answer-only', 'suggest', 'act'];
const BAD = Symbol('unparseable');
const parse = <T>(s: string | undefined): T | undefined | typeof BAD => {
  if (s === undefined) return undefined;
  try { return JSON.parse(s) as T; } catch { return BAD; }
};

export async function readPlatformFlags(env: Pick<Env, 'DB'>): Promise<Pick<RawControls, 'global' | 'product' | 'killedTools' | 'shadow'>> {
  const rows = await env.DB.prepare('SELECT key, value FROM platform_flags WHERE key IN (?, ?, ?)').bind(FLAG.global, FLAG.product, FLAG.tools).all<{ key: string; value: string }>();
  const by = new Map(rows.results.map((r) => [r.key, r.value]));
  // A kill switch that is PRESENT but cannot be read (a hand-edit during an incident) stops the assistant: it never silently stays on.
  const gr = parse<{ kill?: boolean; mode?: Mode; shadow?: boolean }>(by.get(FLAG.global));
  const pr = parse<{ kill?: boolean }>(by.get(FLAG.product));
  const tr = parse<string[]>(by.get(FLAG.tools));
  const g = gr === BAD ? { kill: true } : gr;
  const p = pr === BAD ? { kill: true } : pr;
  const t = tr === BAD ? undefined : tr;
  return {
    global: { ...(g?.kill === true ? { kill: true } : {}), ...(g?.mode && MODES.includes(g.mode) ? { mode: g.mode } : {}) },
    product: { ...(p?.kill === true ? { kill: true } : {}) },
    killedTools: Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [],
    ...(g?.shadow === true ? { shadow: true } : {}),
  };
}

export async function chatControls(env: Pick<Env, 'DB'>, ws: { assistantMode(): Promise<Mode> }): Promise<Controls> {
  try {
    const [flags, storeFlag] = await Promise.all([readPlatformFlags(env), ws.assistantMode()]);
    return resolveControls({ storeFlag, ...flags });
  } catch {
    return resolveControls({ storeFlag: 'off', global: { kill: true } }); // fail closed
  }
}

/** Whether the panel should be offered at all: the same decision the turn route makes (mode other than off after the kill switches). A fail-closed read is simply false. */
export async function assistantEnabled(env: Pick<Env, 'DB' | 'WORKSPACE_DO'>, storeId: string): Promise<boolean> {
  try {
    return await assistantEnabledUnsafe(env, storeId);
  } catch (err) {
    // /me boots the whole app: an optional feature's read error hides the assistant, it never fails /me.
    alert('assistant_status_failed', { workspace: storeId, error: errClass(err) });
    return false;
  }
}

async function assistantEnabledUnsafe(env: Pick<Env, 'DB' | 'WORKSPACE_DO'>, storeId: string): Promise<boolean> {
  if (!(await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first())) return false; // a Durable Object is never created for an unknown id
  const ws = env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(storeId));
  return (await chatControls(env, ws)).mode !== 'off';
}

export async function setPlatformFlag(env: Pick<Env, 'DB'>, key: string, value: unknown, actor: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT INTO platform_flags (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(key, JSON.stringify(value), now, actor).run();
}
