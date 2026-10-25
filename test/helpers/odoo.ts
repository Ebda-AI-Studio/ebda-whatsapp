import type { ConnCall, ConnReply } from './connectors';

export type Fault = { name: string; message: string };
/** A tiny Odoo behind /jsonrpc: authenticate, version and the execute_kw calls the connector makes. Every request is recorded. */
export class FakeOdoo {
  partners: { id: number; name: string; phone: string }[] = [];
  products = [{ id: 11, default_code: 'ROSE-1', name: 'Red roses', qty_available: 24 }, { id: 12, default_code: 'TULIP-1', name: 'Tulips', qty_available: 0 }];
  orders: { id: number; name: string; partner_id: number; client_order_ref: string; order_line: unknown[]; amount_total: number }[] = [];
  events: { id: number; name: string; start: string; stop: string; partner_ids: unknown }[] = [];
  requests: { service: string; method: string; args: any[] }[] = [];
  validKey = 'test-secret-odoo-api-key';
  fault: Fault | null = null;
  private seq = 100;

  handle = (call: ConnCall): ConnReply => {
    if (!call.url.endsWith('/jsonrpc')) return { status: 404, text: 'nope' };
    const { service, method, args } = call.json.params as { service: string; method: string; args: any[] };
    this.requests.push({ service, method, args });
    const ok = (result: unknown): ConnReply => ({ json: { jsonrpc: '2.0', id: call.json.id, result } });
    if (this.fault) return { json: { jsonrpc: '2.0', id: call.json.id, error: { code: 200, message: 'Odoo Server Error', data: { name: this.fault.name, message: this.fault.message, debug: 'Traceback (most recent call last): secret internals' } } } };
    if (service === 'common' && method === 'version') return ok({ server_version: '17.0', protocol_version: 1 });
    if (service === 'common' && method === 'authenticate') return ok(args[2] === this.validKey ? 2 : false);
    if (service === 'object' && method === 'execute_kw') {
      const [, uid, pw, model, m, a, kw] = args;
      if (uid !== 2 || pw !== this.validKey) return { json: { jsonrpc: '2.0', id: call.json.id, error: { data: { name: 'odoo.exceptions.AccessDenied', message: 'Access Denied' } } } };
      return ok(this.model(model, m, a, kw ?? {}));
    }
    return { status: 400, text: 'bad' };
  };

  private model(model: string, m: string, a: any[], kw: any): unknown {
    const id = () => ++this.seq;
    if (model === 'res.partner' && m === 'search_read') {
      const phones: string[] = a[0][0][2];
      return this.partners.filter((p) => phones.includes(p.phone)).slice(0, kw.limit ?? 80).map((p) => ({ id: p.id, name: p.name }));
    }
    if (model === 'res.partner' && m === 'create') {
      const p = { id: id(), name: a[0].name, phone: a[0].phone };
      this.partners.push(p);
      return p.id;
    }
    if (model === 'product.product' && m === 'search_read') {
      const dom = a[0] as any[];
      const clauses = dom.filter((c) => Array.isArray(c));
      return this.products.filter((p) => clauses.some((c) => (c[0] === 'id' ? c[2].includes(p.id) : c[2].includes(p.default_code)))).map((p) => ({ id: p.id, default_code: p.default_code, name: p.name, qty_available: p.qty_available }));
    }
    if (model === 'sale.order' && m === 'search_read') return this.orders.filter((o) => o.client_order_ref === a[0][0][2]).map((o) => ({ name: o.name, amount_total: o.amount_total }));
    if (model === 'sale.order' && m === 'create') {
      const v = a[0];
      const o = { id: id(), name: `S${String(this.orders.length + 1).padStart(5, '0')}`, partner_id: v.partner_id, client_order_ref: v.client_order_ref, order_line: v.order_line, amount_total: 120 };
      this.orders.push(o);
      return o.id;
    }
    if (model === 'sale.order' && m === 'read') {
      const o = this.orders.find((x) => x.id === a[0][0])!;
      return [{ id: o.id, name: o.name, amount_total: o.amount_total, currency_id: [1, 'EGP'] }];
    }
    if (model === 'calendar.event' && m === 'search_count') {
      const [name, start, pids] = (a[0] as [string, string, any][]).map((c) => c[2]) as [string, string, number[]];
      return this.events.filter((e) => e.name === name && e.start === start && pids.some((p) => (e.partner_ids as any)[0][2].includes(p))).length;
    }
    if (model === 'calendar.event' && m === 'create') {
      const e = { id: id(), ...a[0] };
      this.events.push(e);
      return e.id;
    }
    throw new Error(`fake odoo: unhandled ${model}.${m}`);
  }
}
