/**
 * Connectors: tools the AI agent can use to reach a client's own systems (a webhook they run, an Odoo). The agent loop only
 * knows this interface; the tool definition shape is the agent's own (`ToolDef`).
 */
import type { ToolDef } from '../ai/provider';

export type { ToolDef };
export type ConnectorKind = 'webhook' | 'odoo';

/** What a connector call may know about the conversation. The raw phone is reachable only through `buyerPhone()` (never serialised). */
export type ConnectorCtx = {
  workspaceId: string;
  /** HMAC of the buyer's E.164 under the suite secret: stable, not reversible. */
  buyerKey: string;
  conversationId: number;
  /** Stable for this tool call of this turn (a replayed turn derives the same key). */
  idempotencyKey: string;
  /** Epoch ms after which nothing may still be waiting on the client's system. */
  deadline: number;
  /** The buyer's E.164 for the one connector that must give it to the client's system (Odoo). Never log it. */
  buyerPhone(): string | null;
};

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string; message?: string };

export interface Connector {
  id: string;
  tools: ToolDef[];
  call(tool: string, args: unknown, ctx: ConnectorCtx): Promise<ToolResult>;
}

/** Errors of the outbound call, as fixed codes (never a response body, URL or secret). */
export type ConnectorErrorCode = 'blocked_host' | 'timeout' | 'network' | 'redirect' | 'http_error' | 'too_large' | 'bad_response' | 'auth_failed' | 'rejected' | 'unavailable' | 'invalid_arguments' | 'unknown_tool' | 'not_found';
export class ConnectorError extends Error {
  constructor(readonly code: ConnectorErrorCode, readonly detail?: string) {
    super(`connector ${code}`);
    this.name = 'ConnectorError';
  }
}
