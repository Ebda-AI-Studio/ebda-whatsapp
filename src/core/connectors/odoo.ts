/**
 * The Odoo connector: JSON-RPC over HTTPS (`POST <url>/jsonrpc`), service `common` (version, authenticate) and `object`
 * (execute_kw). Four tools. The model never supplies a customer: the partner is always the buyer of this conversation, found or
 * created by the E.164 held only inside the call. Odoo has no idempotency keys, so duplicates are checked on a field Odoo does
 * keep (`client_order_ref` on a quotation; name + start + attendee on an event). Models and fields follow Odoo's ORM reference:
 * res.partner, sale.order, sale.order.line, product.product, calendar.event; relational writes use the literal command tuples
 * (0, 0, values) and (6, 0, ids); datetimes are UTC strings `YYYY-MM-DD HH:MM:SS`.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import type { OdooConfig } from '../api/contract';
import type { ToolDef } from '../ai/provider';
import { connectorFetch } from './net';
import { ConnectorError, type Connector, type ConnectorCtx, type ToolResult } from './types';

const MESSAGE_CHARS = 200;
const rpcReply = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional(), data: z.object({ name: z.string().optional(), message: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
});

/** One uid per (workspace, connector, settings version); a rewrite of the settings changes `updatedAt` and so the key. Bounded. */
const uidCache = new Map<string, number>();
const UID_CACHE_MAX = 200;

type Deps = { env: Env; workspaceId: string; id: string; config: OdooConfig; updatedAt: number; secret: () => Promise<string | null> };

async function rpc(env: Env, base: string, service: 'common' | 'object', method: string, args: unknown[], deadline: number): Promise<unknown> {
  const res = await connectorFetch(env, `${base}/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: Math.floor(Math.random() * 1e9) }),
  }, { deadline });
  if (res.status < 200 || res.status >= 300) throw new ConnectorError('http_error', String(res.status));
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new ConnectorError('bad_response');
  }
  const parsed = rpcReply.safeParse(json);
  if (!parsed.success) throw new ConnectorError('bad_response');
  const fault = parsed.data.error;
  if (fault) {
    // Odoo's debug trace is never read; only the exception class and its short message.
    const name = fault.data?.name ?? '';
    const msg = (fault.data?.message ?? '').replace(/\s+/g, ' ').slice(0, MESSAGE_CHARS);
    if (/AccessDenied/.test(name)) throw new ConnectorError('auth_failed');
    if (/AccessError/.test(name)) throw new ConnectorError('access_denied');
    if (/MissingError/.test(name)) throw new ConnectorError('not_found');
    if (/(ValidationError|UserError|ValueError)/.test(name)) throw new ConnectorError('rejected', msg);
    throw new ConnectorError('server_error');
  }
  return parsed.data.result;
}

class Session {
  private uid: number | null = null;
  constructor(private readonly d: Deps, private readonly secret: string, private readonly deadline: number) {}
  private get key() { return `${this.d.workspaceId}|${this.d.id}|${this.d.updatedAt}`; }
  async login(): Promise<number> {
    if (this.uid !== null) return this.uid;
    const cached = uidCache.get(this.key);
    if (cached !== undefined) return (this.uid = cached);
    const r = await rpc(this.d.env, this.d.config.url, 'common', 'authenticate', [this.d.config.database, this.d.config.login, this.secret, {}], this.deadline);
    if (typeof r !== 'number' || r <= 0) throw new ConnectorError('auth_failed');
    if (uidCache.size >= UID_CACHE_MAX) uidCache.clear();
    uidCache.set(this.key, r);
    return (this.uid = r);
  }
  async kw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const uid = await this.login();
    try {
      return await rpc(this.d.env, this.d.config.url, 'object', 'execute_kw', [this.d.config.database, uid, this.secret, model, method, args, kwargs], this.deadline);
    } catch (e) {
      if (e instanceof ConnectorError && e.code === 'auth_failed') uidCache.delete(this.key);
      throw e;
    }
  }
}

const rec = z.array(z.record(z.string(), z.unknown()));
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---- tools ---------------------------------------------------------------------------------------------------------------

const intId = z.number().int().positive();
const partnerArgs = z.object({ name: z.string().trim().min(1).max(100).optional() });
const lineArgs = z.object({ productId: intId.optional(), code: z.string().trim().min(1).max(64).optional(), qty: z.number().positive().max(10_000) }).refine((l) => (l.productId === undefined) !== (l.code === undefined), 'productId or code');
const orderArgs = z.object({ lines: z.array(lineArgs).min(1).max(20) });
const stockArgs = z.object({ ids: z.array(intId).max(10).optional(), codes: z.array(z.string().trim().min(1).max(64)).max(10).optional() }).refine((a) => (a.ids?.length ?? 0) + (a.codes?.length ?? 0) > 0, 'ids or codes');
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const iso = z.string().regex(ISO_WITH_OFFSET).refine((s) => Number.isFinite(Date.parse(s)));
const bookingArgs = z.object({ name: z.string().trim().min(1).max(100), start: iso, end: iso.optional(), durationMinutes: z.number().int().min(5).max(480).optional() })
  .refine((a) => !(a.end && a.durationMinutes), 'end or durationMinutes');

export const ODOO_TOOL_DEFS: ToolDef[] = [
  {
    name: 'find_or_create_partner',
    description: "Make sure this customer exists in the company's Odoo contacts (matched by their WhatsApp number, which you never see). Optional: the name the customer gave.",
    parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 100, description: 'The name the customer gave, if any.' } } },
  },
  {
    name: 'create_sale_order',
    description: 'Create a draft quotation for this customer (staff confirm it later). Each line is a product (productId from read_stock, or its code) and a quantity. Returns the quotation number and total.',
    parameters: { type: 'object', properties: { lines: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { productId: { type: 'number' }, code: { type: 'string', maxLength: 64 }, qty: { type: 'number', minimum: 0 } }, required: ['qty'] } } }, required: ['lines'] },
  },
  {
    name: 'read_stock',
    description: 'Check how many units are in stock for products, by product id or product code (up to 10).',
    parameters: { type: 'object', properties: { ids: { type: 'array', maxItems: 10, items: { type: 'number' } }, codes: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 64 } } } },
  },
  {
    name: 'create_calendar_booking',
    description: 'Book a reservation in the calendar for this customer. start (and end, if given) are ISO 8601 with a time zone offset, e.g. 2026-11-02T18:30:00+02:00. Give end or durationMinutes (default 60).',
    parameters: { type: 'object', properties: { name: { type: 'string', maxLength: 100 }, start: { type: 'string' }, end: { type: 'string' }, durationMinutes: { type: 'number', minimum: 5, maximum: 480 } }, required: ['name', 'start'] },
  },
];

const odooUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

async function partnerFor(s: Session, ctx: ConnectorCtx, name?: string): Promise<{ id: number; name: string | null; created: boolean }> {
  const e164 = ctx.buyerPhone();
  if (!e164) throw new ConnectorError('unavailable');
  const digits = e164.replace(/^\+/, '');
  const found = rec.parse(await s.kw('res.partner', 'search_read', [[['phone', 'in', [e164, digits, `00${digits}`]]]], { fields: ['id', 'name'], limit: 1 }));
  const hit = found[0];
  if (hit && num(hit.id) !== null) return { id: hit.id as number, name: typeof hit.name === 'string' ? hit.name : null, created: false };
  const id = num(await s.kw('res.partner', 'create', [{ name: name ?? `WhatsApp ${e164}`, phone: e164 }]));
  if (id === null) throw new ConnectorError('bad_response');
  return { id, name: name ?? null, created: true };
}

async function createOrder(s: Session, ctx: ConnectorCtx, a: z.infer<typeof orderArgs>): Promise<unknown> {
  const dup = rec.parse(await s.kw('sale.order', 'search_read', [[['client_order_ref', '=', ctx.idempotencyKey]]], { fields: ['name', 'amount_total'], limit: 1 }))[0];
  if (dup) return { orderName: dup.name, total: dup.amount_total, duplicate: true };
  const codes = [...new Set(a.lines.flatMap((l) => (l.code ? [l.code] : [])))];
  const byCode = new Map<string, number>();
  if (codes.length) {
    for (const p of rec.parse(await s.kw('product.product', 'search_read', [[['default_code', 'in', codes]]], { fields: ['id', 'default_code'], limit: codes.length * 2 }))) {
      if (typeof p.default_code === 'string' && num(p.id) !== null) byCode.set(p.default_code, p.id as number);
    }
  }
  const lines: unknown[] = [];
  for (const l of a.lines) {
    const productId = l.productId ?? byCode.get(l.code!);
    if (productId === undefined) throw new ConnectorError('not_found', `unknown product code ${l.code}`);
    lines.push([0, 0, { product_id: productId, product_uom_qty: l.qty }]);
  }
  const partner = await partnerFor(s, ctx);
  const id = num(await s.kw('sale.order', 'create', [{ partner_id: partner.id, client_order_ref: ctx.idempotencyKey, order_line: lines }]));
  if (id === null) throw new ConnectorError('bad_response');
  const made = rec.parse(await s.kw('sale.order', 'read', [[id], ['name', 'amount_total', 'currency_id']]))[0];
  const cur = Array.isArray(made?.currency_id) ? made.currency_id[1] : null;
  return { orderName: made?.name ?? null, total: made?.amount_total ?? null, currency: typeof cur === 'string' ? cur : null };
}

async function readStock(s: Session, a: z.infer<typeof stockArgs>): Promise<unknown> {
  const parts: unknown[] = [];
  if (a.ids?.length) parts.push(['id', 'in', a.ids]);
  if (a.codes?.length) parts.push(['default_code', 'in', a.codes]);
  const domain = parts.length === 2 ? ['|', ...parts] : parts;
  const items = rec.parse(await s.kw('product.product', 'search_read', [domain], { fields: ['id', 'default_code', 'name', 'qty_available'], limit: 20 }));
  return { items: items.map((p) => ({ productId: p.id, code: p.default_code || null, name: p.name, qtyAvailable: p.qty_available })) };
}

async function createBooking(s: Session, ctx: ConnectorCtx, a: z.infer<typeof bookingArgs>): Promise<unknown> {
  const start = Date.parse(a.start);
  const stop = a.end ? Date.parse(a.end) : start + (a.durationMinutes ?? 60) * 60_000;
  if (stop <= start) throw new ConnectorError('invalid_arguments');
  const partner = await partnerFor(s, ctx);
  const same = num(await s.kw('calendar.event', 'search_count', [[['name', '=', a.name], ['start', '=', odooUtc(start)], ['partner_ids', 'in', [partner.id]]]]));
  if (same && same > 0) return { duplicate: true, start: odooUtc(start), stop: odooUtc(stop) };
  const id = num(await s.kw('calendar.event', 'create', [{ name: a.name, start: odooUtc(start), stop: odooUtc(stop), partner_ids: [[6, 0, [partner.id]]] }]));
  if (id === null) throw new ConnectorError('bad_response');
  return { eventId: id, start: odooUtc(start), stop: odooUtc(stop), timeZone: 'UTC' };
}

export function odooConnector(d: Deps): Connector {
  return {
    id: d.id,
    tools: ODOO_TOOL_DEFS,
    async call(tool, args, ctx): Promise<ToolResult> {
      const def = ODOO_TOOL_DEFS.find((t) => t.name === tool);
      if (!def) return { ok: false, error: 'unknown_tool' };
      const secret = await d.secret();
      if (!secret) return { ok: false, error: 'unavailable' };
      const s = new Session(d, secret, ctx.deadline);
      try {
        switch (tool) {
          case 'find_or_create_partner': {
            const a = partnerArgs.safeParse(args ?? {});
            if (!a.success) return { ok: false, error: 'invalid_arguments' };
            const p = await partnerFor(s, ctx, a.data.name);
            return { ok: true, result: { partnerId: p.id, name: p.name, created: p.created } };
          }
          case 'create_sale_order': {
            const a = orderArgs.safeParse(args);
            return a.success ? { ok: true, result: await createOrder(s, ctx, a.data) } : { ok: false, error: 'invalid_arguments' };
          }
          case 'read_stock': {
            const a = stockArgs.safeParse(args);
            return a.success ? { ok: true, result: await readStock(s, a.data) } : { ok: false, error: 'invalid_arguments' };
          }
          default: {
            const a = bookingArgs.safeParse(args);
            return a.success ? { ok: true, result: await createBooking(s, ctx, a.data) } : { ok: false, error: 'invalid_arguments' };
          }
        }
      } catch (e) {
        if (e instanceof ConnectorError) return { ok: false, error: e.code, ...(e.detail && (e.code === 'rejected' || e.code === 'not_found') ? { message: e.detail } : {}) };
        if (e instanceof z.ZodError) return { ok: false, error: 'bad_response' };
        return { ok: false, error: 'network' };
      }
    },
  };
}

/** "Test connection": `common.version` (no login) and then `authenticate`. */
export async function pingOdoo(env: Env, config: OdooConfig, secret: string): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const deadline = Date.now() + 12_000;
  try {
    const v = await rpc(env, config.url, 'common', 'version', [], deadline);
    const server = v && typeof v === 'object' && 'server_version' in v ? String((v as { server_version: unknown }).server_version).slice(0, 30) : undefined;
    const uid = await rpc(env, config.url, 'common', 'authenticate', [config.database, config.login, secret, {}], deadline);
    if (typeof uid !== 'number' || uid <= 0) return { ok: false, error: 'auth_failed', ...(server ? { detail: server } : {}) };
    return { ok: true, ...(server ? { detail: server } : {}) };
  } catch (e) {
    return e instanceof ConnectorError ? { ok: false, error: e.code, ...(e.detail ? { detail: e.detail } : {}) } : { ok: false, error: 'network' };
  }
}
