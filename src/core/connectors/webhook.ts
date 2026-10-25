/**
 * The generic webhook connector: the client declares tools in settings; a call is one HMAC-signed HTTPS POST to their endpoint.
 * No retries here: the model is told the call failed, and a non-idempotent call is never repeated behind its back (the client
 * deduplicates on the `idempotency-key` header if the model itself asks again).
 */
import { z } from 'zod';
import type { Env } from '../../env';
import type { WebhookConfig, WebhookParam, WebhookTool } from '../api/contract';
import type { ToolDef } from '../ai/provider';
import { connectorFetch } from './net';
import { ConnectorError, type Connector, type ConnectorCtx, type ToolResult } from './types';

const MESSAGE_CHARS = 300;
const reply = z.object({ ok: z.boolean(), result: z.unknown().optional(), message: z.string().optional() });

const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/** `sha256=<hex HMAC(secret, timestamp + "." + body)>`: what the client recomputes over the raw body to verify a call. */
export async function signWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

function paramSchema(p: WebhookParam): z.ZodType {
  let t: z.ZodType;
  switch (p.type) {
    case 'string': t = z.string().trim().min(p.required ? 1 : 0).max(p.maxLength ?? 200); break;
    case 'number': t = z.number().finite().min(p.min ?? -1e12).max(p.max ?? 1e12); break;
    case 'boolean': t = z.boolean(); break;
    case 'enum': t = z.enum(p.values as [string, ...string[]]); break;
  }
  return p.required ? t : t.optional();
}
const argsSchema = (t: WebhookTool) => z.object(Object.fromEntries(t.params.map((p) => [p.name, paramSchema(p)])));

/** The tool as the model sees it: JSON schema limited to the four allowed types. */
export function toolDef(t: WebhookTool): ToolDef {
  const properties: Record<string, unknown> = {};
  for (const p of t.params) {
    properties[p.name] = {
      type: p.type === 'enum' ? 'string' : p.type,
      ...(p.description ? { description: p.description } : {}),
      ...(p.type === 'enum' ? { enum: p.values } : {}),
      ...(p.type === 'string' ? { maxLength: p.maxLength ?? 200 } : {}),
      ...(p.type === 'number' && p.min !== undefined ? { minimum: p.min } : {}),
      ...(p.type === 'number' && p.max !== undefined ? { maximum: p.max } : {}),
    };
  }
  const required = t.params.filter((p) => p.required).map((p) => p.name);
  return { name: t.name, description: t.description, parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } };
}

async function post(env: Env, cfg: WebhookConfig, secret: string, payload: Record<string, unknown>, idempotencyKey: string, deadline: number): Promise<z.infer<typeof reply>> {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const res = await connectorFetch(env, cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': await signWebhook(secret, timestamp, body), 'x-timestamp': timestamp, 'idempotency-key': idempotencyKey },
    body,
  }, { deadline });
  if (res.status < 200 || res.status >= 300) throw new ConnectorError('http_error', String(res.status));
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new ConnectorError('bad_response');
  }
  const parsed = reply.safeParse(json);
  if (!parsed.success) throw new ConnectorError('bad_response');
  return parsed.data;
}

export function webhookConnector(deps: { env: Env; id: string; config: WebhookConfig; secret: () => Promise<string | null> }): Connector {
  const byName = new Map(deps.config.tools.map((t) => [t.name, t]));
  return {
    id: deps.id,
    tools: deps.config.tools.map(toolDef),
    async call(tool: string, args: unknown, ctx: ConnectorCtx): Promise<ToolResult> {
      const def = byName.get(tool);
      if (!def) return { ok: false, error: 'unknown_tool' };
      const parsed = argsSchema(def).safeParse(args ?? {});
      if (!parsed.success) return { ok: false, error: 'invalid_arguments' };
      const secret = await deps.secret();
      if (!secret) return { ok: false, error: 'unavailable' };
      try {
        const out = await post(deps.env, deps.config, secret, {
          event: 'tool_call', tool, args: parsed.data, workspaceId: ctx.workspaceId, conversationId: ctx.conversationId,
          buyerKey: ctx.buyerKey, idempotencyKey: ctx.idempotencyKey, at: new Date().toISOString(),
        }, ctx.idempotencyKey, ctx.deadline);
        return out.ok ? { ok: true, result: out.result ?? null } : { ok: false, error: 'rejected', ...(out.message ? { message: out.message.slice(0, MESSAGE_CHARS) } : {}) };
      } catch (e) {
        return { ok: false, error: e instanceof ConnectorError ? e.code : 'network' };
      }
    },
  };
}

/** The harmless call behind "test connection": a signed `ping` event. */
export async function pingWebhook(env: Env, config: WebhookConfig, secret: string, workspaceId: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  try {
    const out = await post(env, config, secret, { event: 'ping', workspaceId, at: new Date().toISOString() }, `ping:${workspaceId}:${Date.now()}`, Date.now() + 8_000);
    return out.ok ? { ok: true } : { ok: false, error: 'rejected' };
  } catch (e) {
    return e instanceof ConnectorError ? { ok: false, error: e.code, ...(e.detail ? { detail: e.detail } : {}) } : { ok: false, error: 'network' };
  }
}
