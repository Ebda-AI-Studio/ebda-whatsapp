/**
 * Per-workspace connector settings (table `connectors` in the workspace Durable Object). The secret is stored AES-GCM encrypted
 * (workspace id as associated data, same helper as the merchant's model key) and is never part of any DTO.
 */
import type { ConnectorDto, ConnectorPut, OdooConfig, WebhookConfig } from '../api/contract';
import { odooConfig, webhookConfig } from '../api/contract';
import type { Env } from '../../env';
import { agentConfig } from '../ai/config';
import { decryptSecret, encryptSecret } from '../ai/secrets';
import { connectorHostAllowed } from './net';
import type { ConnectorKind } from './types';

type Sql = Pick<DurableObjectStorage, 'sql'>['sql'];
export const MAX_CONNECTORS = 5;
export const TOOL_SEP = '__';

export type ConnectorRow =
  | { id: string; kind: 'webhook'; enabled: boolean; config: WebhookConfig; hasSecret: boolean; updatedAt: number; updatedBy: string | null }
  | { id: string; kind: 'odoo'; enabled: boolean; config: OdooConfig; hasSecret: boolean; updatedAt: number; updatedBy: string | null };

type Raw = { id: string; kind: ConnectorKind; enabled: number; config_json: string; secret_enc: string | null; updated_at: number; updated_by: string | null };

function toRow(r: Raw): ConnectorRow | null {
  let json: unknown;
  try {
    json = JSON.parse(r.config_json);
  } catch {
    return null;
  }
  const base = { id: r.id, enabled: r.enabled === 1, hasSecret: r.secret_enc !== null, updatedAt: r.updated_at, updatedBy: r.updated_by };
  if (r.kind === 'webhook') {
    const c = webhookConfig.safeParse(json);
    return c.success ? { ...base, kind: 'webhook', config: c.data } : null;
  }
  const c = odooConfig.safeParse(json);
  return c.success ? { ...base, kind: 'odoo', config: c.data } : null;
}

export function listConnectors(sql: Sql): ConnectorRow[] {
  return sql.exec<Raw>('SELECT id, kind, enabled, config_json, secret_enc, updated_at, updated_by FROM connectors ORDER BY id').toArray().map(toRow).filter((r): r is ConnectorRow => r !== null);
}
export const getConnector = (sql: Sql, id: string): ConnectorRow | null => listConnectors(sql).find((r) => r.id === id) ?? null;

/** The names the model sees for a connector. */
export const toolNames = (r: ConnectorRow): string[] => (r.kind === 'webhook' ? r.config.tools.map((t) => `${r.id}${TOOL_SEP}${t.name}`) : ODOO_TOOLS.map((t) => `${r.id}${TOOL_SEP}${t}`));
export const ODOO_TOOLS = ['find_or_create_partner', 'create_sale_order', 'read_stock', 'create_calendar_booking'] as const;

export const connectorDto = (r: ConnectorRow): ConnectorDto => ({ id: r.id, kind: r.kind, enabled: r.enabled, hasSecret: r.hasSecret, config: r.config, tools: toolNames(r), updatedAt: r.updatedAt, updatedBy: r.updatedBy });

/** The plain secret, or null when none is stored or it cannot be opened. */
export async function connectorSecret(env: Env, workspaceId: string, sql: Sql, id: string): Promise<string | null> {
  const stored = sql.exec<{ secret_enc: string | null }>('SELECT secret_enc FROM connectors WHERE id = ?', id).toArray()[0]?.secret_enc;
  const master = agentConfig().secretsKey(env);
  return stored && master ? decryptSecret(stored, master, workspaceId) : null;
}

export type PutRefusal = 'invalid_url' | 'secret_required' | 'secrets_unavailable' | 'kind_mismatch' | 'too_many_connectors';
export type Plan = { ok: true; row: ConnectorRow; secretEnc: string | null } | { ok: false; reason: PutRefusal };

const originOf = (u: string): string => new URL(u).origin;

/** Validates a PUT against what is stored; nothing is written here. */
export async function planConnectorPut(env: Env, workspaceId: string, sql: Sql, id: string, body: ConnectorPut, actor: string | null, now: number): Promise<Plan> {
  const existing = sql.exec<Raw>('SELECT id, kind, enabled, config_json, secret_enc, updated_at, updated_by FROM connectors WHERE id = ?', id).toArray()[0];
  if (existing && existing.kind !== body.kind) return { ok: false, reason: 'kind_mismatch' };
  if (!existing && sql.exec<{ n: number }>('SELECT count(*) AS n FROM connectors').one().n >= MAX_CONNECTORS) return { ok: false, reason: 'too_many_connectors' };
  const url = connectorHostAllowed(env, body.config.url);
  if (!url) return { ok: false, reason: 'invalid_url' };
  let secretEnc = existing?.secret_enc ?? null;
  // The stored secret may only ever go to the host it was saved for: another origin needs a fresh secret in the same request.
  if (body.secret === undefined && existing && secretEnc !== null) {
    const before = toRow(existing);
    if (before && originOf(before.config.url) !== originOf(url)) return { ok: false, reason: 'secret_required' };
  }
  if (body.secret !== undefined) {
    const master = agentConfig().secretsKey(env);
    if (!master) return { ok: false, reason: 'secrets_unavailable' };
    secretEnc = await encryptSecret(body.secret, master, workspaceId);
  }
  if (body.enabled && secretEnc === null) return { ok: false, reason: 'secret_required' };
  const base = { id, enabled: body.enabled, hasSecret: secretEnc !== null, updatedAt: now, updatedBy: actor };
  const row: ConnectorRow = body.kind === 'webhook' ? { ...base, kind: 'webhook', config: { ...body.config, url } } : { ...base, kind: 'odoo', config: { ...body.config, url } };
  return { ok: true, row, secretEnc };
}

export function writeConnector(sql: Sql, row: ConnectorRow, secretEnc: string | null): void {
  sql.exec(
    `INSERT INTO connectors (id, kind, enabled, config_json, secret_enc, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, secret_enc = excluded.secret_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    row.id, row.kind, row.enabled ? 1 : 0, JSON.stringify(row.config), secretEnc, row.updatedAt, row.updatedBy,
  );
}
export const deleteConnector = (sql: Sql, id: string): boolean => sql.exec('DELETE FROM connectors WHERE id = ?', id).rowsWritten > 0;
