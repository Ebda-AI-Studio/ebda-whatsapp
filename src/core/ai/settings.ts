import type { z } from 'zod';
import { agentSettingsFields } from '../api/contract';
import type { Env } from '../../env';
import { agentConfig } from './config';
import { validBaseUrl, type LlmProvider } from './provider';
import { decryptSecret, encryptSecret } from './secrets';
import type { PromisePolicy } from './reply-guard';

/** Workspace settings of the AI agent (stored as key/value text in `agent_state`). The shape is the API contract's. */
export const agentSettingsSchema = agentSettingsFields;
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = { enabled: false, persona: '', language: 'ar', handoffMinutes: 120, faqText: '', provider: 'workers-ai', model: null, baseUrl: null, allowRefund: false, allowDiscount: false, allowFreeDelivery: false, allowExchange: false, allowGuarantee: false, recommendProducts: true };
/** The promise policy the reply guard applies (Ruling WA-GUARD-PROMISE-1): off unless the merchant switched it on. */
export const promisePolicyOf = (s: AgentSettings): PromisePolicy => ({ refund: s.allowRefund, discount: s.allowDiscount, freeDelivery: s.allowFreeDelivery, exchange: s.allowExchange, guarantee: s.allowGuarantee });
const BOOLEAN_KEYS: ReadonlySet<keyof AgentSettings> = new Set(['enabled', 'allowRefund', 'allowDiscount', 'allowFreeDelivery', 'allowExchange', 'allowGuarantee', 'recommendProducts']);

/** What a PUT may carry. `apiKey` is write-only: a string sets it, null removes it, absent keeps it. */
export type AgentSettingsUpdate = Partial<AgentSettings> & { apiKey?: string | null };

type Sql = Pick<DurableObjectStorage, 'sql'>['sql'];
const KEYS = Object.keys(DEFAULT_AGENT_SETTINGS) as (keyof AgentSettings)[];

export const getAgentState = (sql: Sql, key: string): string | null => sql.exec<{ value: string }>('SELECT value FROM agent_state WHERE key = ?', key).toArray()[0]?.value ?? null;
export const putAgentState = (sql: Sql, key: string, value: string): void => {
  sql.exec('INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
};

export function readAgentSettings(sql: Sql): AgentSettings {
  const stored = new Map(sql.exec<{ key: string; value: string }>("SELECT key, value FROM agent_state WHERE key LIKE 'setting.%'").toArray().map((r) => [r.key.slice(8), r.value]));
  const out: AgentSettings = { ...DEFAULT_AGENT_SETTINGS };
  for (const k of KEYS) {
    const v = stored.get(k);
    if (v === undefined) continue;
    if (BOOLEAN_KEYS.has(k)) (out as Record<string, unknown>)[k] = v === '1';
    else if (k === 'handoffMinutes') out.handoffMinutes = Number(v) || DEFAULT_AGENT_SETTINGS.handoffMinutes;
    else if (k === 'model' || k === 'baseUrl') out[k] = v === '' ? null : v;
    else if (k === 'language') out.language = v === 'en' || v === 'auto' ? v : 'ar';
    else if (k === 'provider') out.provider = v === 'openai-compatible' ? 'openai-compatible' : 'workers-ai';
    else (out as Record<string, unknown>)[k] = v; // persona, faqText
  }
  return out;
}

export function hasApiKey(sql: Sql): boolean {
  return getAgentState(sql, 'secret.apiKey') !== null;
}

export type SettingsRefusal = 'invalid_base_url' | 'model_required' | 'api_key_required' | 'secrets_unavailable' | 'model_not_allowed';

/** Validates `patch` against what is stored and returns the new settings plus the encrypted key to write; nothing is written here. */
export async function planAgentUpdate(env: Env, workspaceId: string, sql: Sql, patch: AgentSettingsUpdate): Promise<{ ok: true; settings: AgentSettings; secret: { set: string } | { clear: true } | null } | { ok: false; reason: SettingsRefusal }> {
  const { apiKey, ...rest } = patch;
  const before = readAgentSettings(sql);
  const next: AgentSettings = { ...before, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
  if (next.baseUrl !== null) {
    const clean = validBaseUrl(next.baseUrl, agentConfig().allowedHosts(env));
    if (!clean) return { ok: false, reason: 'invalid_base_url' };
    next.baseUrl = clean;
  }
  // The stored key may only ever go to the host it was saved for: a different origin needs a fresh key in the same request (or an explicit removal).
  const originOf = (u: string | null) => (u ? new URL(u).origin : null);
  if (apiKey === undefined && next.baseUrl !== null && originOf(next.baseUrl) !== originOf(before.baseUrl) && hasApiKey(sql)) return { ok: false, reason: 'api_key_required' };
  let secret: { set: string } | { clear: true } | null = null;
  if (apiKey !== undefined && apiKey !== null) {
    const key = agentConfig().secretsKey(env);
    if (!key) return { ok: false, reason: 'secrets_unavailable' };
    secret = { set: await encryptSecret(apiKey, key, workspaceId) };
  } else if (apiKey === null) secret = { clear: true };
  const keyAfter = secret ? ('set' in secret) : hasApiKey(sql);
  if (next.provider === 'openai-compatible') {
    if (!next.model) return { ok: false, reason: 'model_required' };
    if (!next.baseUrl) return { ok: false, reason: 'invalid_base_url' };
    // Checked only while the agent is on, so a merchant can save the endpoint first and the key a moment later.
    if (next.enabled && !keyAfter) return { ok: false, reason: 'api_key_required' };
  } else if (next.model !== null) {
    return { ok: false, reason: 'model_not_allowed' };
  }
  return { ok: true, settings: next, secret };
}

export function writeAgentSettings(sql: Sql, s: AgentSettings, secret: { set: string } | { clear: true } | null): void {
  for (const k of KEYS) putAgentState(sql, `setting.${k}`, BOOLEAN_KEYS.has(k) ? (s[k] ? '1' : '0') : s[k] === null ? '' : String(s[k]));
  if (secret && 'set' in secret) putAgentState(sql, 'secret.apiKey', secret.set);
  else if (secret) sql.exec("DELETE FROM agent_state WHERE key = 'secret.apiKey'");
}

/** The model for this workspace, or null when it cannot be built (no AI binding, key missing or unreadable). */
export async function providerFor(env: Env, workspaceId: string, sql: Sql, settings: AgentSettings): Promise<LlmProvider | null> {
  let apiKey: string | null = null;
  if (settings.provider === 'openai-compatible') {
    const stored = getAgentState(sql, 'secret.apiKey');
    const master = agentConfig().secretsKey(env);
    if (stored && master) apiKey = await decryptSecret(stored, master, workspaceId);
  }
  return agentConfig().provider(env, { settings, apiKey });
}
