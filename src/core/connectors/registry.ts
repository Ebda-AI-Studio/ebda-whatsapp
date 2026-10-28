/** The connectors a turn may use: enabled ones only, tool names prefixed with the connector id (`<id>__<tool>`). */
import type { Env } from '../../env';
import { buyerKey } from '../buyer-key';
import { errClass, alert } from '../observability';
import { isE164 } from '../phone';
import { storeLink } from '../store-link';
import type { ToolDef } from '../ai/provider';
import { maskForModel } from '../ai/mask';
import { connectorSecret, listConnectors, TOOL_SEP, type ConnectorRow } from './store';
import { odooConnector, pingOdoo } from './odoo';
import { pingWebhook, webhookConnector } from './webhook';
import type { Connector, ConnectorCtx, ToolResult } from './types';

type Host = { sql: SqlStorage; env: Env; workspaceId: string };

/** How long one tool call may wait on the client's system in all (a request is bounded to 8 s on its own). Tests shorten it. */
export const connectorLimits = { callWindowMs: 12_000 };
const CONTENT_MAX = 3000;

function build(host: Host, row: ConnectorRow): Connector {
  const secret = () => connectorSecret(host.env, host.workspaceId, host.sql, row.id);
  return row.kind === 'webhook'
    ? webhookConnector({ env: host.env, id: row.id, config: row.config, secret })
    : odooConnector({ env: host.env, workspaceId: host.workspaceId, id: row.id, config: row.config, updatedAt: row.updatedAt, secret });
}

export type ConnectorSet = { tools: ToolDef[]; owns(name: string): boolean; call(name: string, args: unknown, ctx: ConnectorCtx): Promise<ToolResult> };

/** Null when no connector is enabled. The caller has already established that the agent is on. */
export function loadConnectors(host: Host): ConnectorSet | null {
  const rows = listConnectors(host.sql).filter((r) => r.enabled && r.hasSecret);
  if (!rows.length) return null;
  const byId = new Map(rows.map((r) => [r.id, build(host, r)]));
  const tools: ToolDef[] = [];
  for (const [id, c] of byId) for (const t of c.tools) tools.push({ ...t, name: `${id}${TOOL_SEP}${t.name}` });
  const names = new Set(tools.map((t) => t.name));
  return {
    tools,
    owns: (name) => names.has(name),
    async call(name, args, ctx) {
      const at = name.indexOf(TOOL_SEP);
      const id = name.slice(0, at);
      const c = byId.get(id);
      if (at < 0 || !c) return { ok: false, error: 'unknown_tool' };
      // Switched off (or removed) while the turn was running: no call.
      if (!listConnectors(host.sql).some((r) => r.id === id && r.enabled)) return { ok: false, error: 'unavailable' };
      return c.call(name.slice(at + TOOL_SEP.length), args, ctx);
    },
  };
}

/** Every string in a connector's result, masked the way a customer's text is (phones, cards, e-mails) before any model reads it (M-177): success results too, not only error text. */
function maskDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return maskForModel(v);
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskDeep(x, depth + 1)]));
}

/** What the model reads back: bounded JSON, never a stack or a raw body, every string masked. */
export function toolContent(res: ToolResult): string {
  // M-177: the client's text is free text from their system (it can echo a phone, a card, an e-mail): masked before the model reads it, in errors AND in results.
  const text = JSON.stringify(res.ok ? { ok: true, result: maskDeep(res.result) } : { ok: false, error: maskForModel(String(res.error)), ...(res.message ? { message: maskForModel(res.message) } : {}) });
  if (text.length <= CONTENT_MAX) return text;
  return JSON.stringify({ ok: res.ok, truncated: true, result: text.slice(0, CONTENT_MAX - 100) });
}

/** "Test connection" for the owner: a harmless call, answered as a fixed code. */
export async function testConnector(host: Host, id: string): Promise<{ ok: boolean; error?: string; detail?: string } | null> {
  const row = listConnectors(host.sql).find((r) => r.id === id);
  if (!row) return null;
  const secret = await connectorSecret(host.env, host.workspaceId, host.sql, id);
  if (!secret) return { ok: false, error: 'secret_required' };
  return row.kind === 'webhook' ? pingWebhook(host.env, row.config, secret, host.workspaceId) : pingOdoo(host.env, row.config, secret);
}

/**
 * The context of one tool call for the customer `from` (WhatsApp id, digits). Null when the suite secret that derives the buyer key
 * is not configured or the number is not E.164: such a call is not made.
 */
export async function connectorCtx(host: Host, from: string, idempotencyKey: string): Promise<ConnectorCtx | null> {
  const secret = storeLink().buyerSecret(host.env);
  const e164 = `+${from}`;
  if (!secret || !isE164(e164)) return null;
  const conv = host.sql.exec<{ id: number }>('SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', from).toArray()[0];
  if (!conv) return null;
  return { workspaceId: host.workspaceId, buyerKey: await buyerKey(secret, e164), conversationId: conv.id, idempotencyKey, deadline: Date.now() + connectorLimits.callWindowMs, buyerPhone: () => e164 };
}

/** One tool call, end to end: context, call, log of failures as classes only (never arguments, results or the number). */
export async function runConnectorTool(host: Host, set: ConnectorSet, from: string, name: string, args: unknown, idempotencyKey: string): Promise<string> {
  let res: ToolResult;
  try {
    const ctx = await connectorCtx(host, from, idempotencyKey);
    res = ctx ? await set.call(name, args, ctx) : { ok: false, error: 'unavailable' };
  } catch (e) {
    alert('connector_call_crashed', { workspace: host.workspaceId, tool: name.slice(0, 60), error: errClass(e) });
    res = { ok: false, error: 'unavailable' };
  }
  if (!res.ok) alert('connector_call_failed', { workspace: host.workspaceId, tool: name.slice(0, 60), error: res.error });
  return toolContent(res);
}
